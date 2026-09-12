import { Platform } from 'react-native';
import { supabase } from './supabase';
import { readAsStringAsync } from 'expo-file-system/legacy';
import { decode as base64Decode } from 'base64-arraybuffer';
import { saveParentRefreshToken } from './biometrics';

interface OnboardingParams {
  email:    string;
  password: string;
  parent: {
    firstName:              string;
    lastName:               string;
    displayName:            string;
    mobile:                 string;
    address:                string;
    safetyPoolLimit:        number;
    weeklyAllowance:        number;
    marketingNotifications: boolean;
  };
  child: {
    displayName:  string;
    username:     string;
    password:     string;
    mobile:       string;
    age:          number;
    avatarEmoji:  string;
    trustScore:   number;
    balance:      number;
    loanedOut:    number;
    borrowed:     number;
    streak:       number;
    repaid:       number;
    missed:       number;
    totalBorrowed: number;
    totalLent:    number;
    points:       number;
  };
}

export const db = {
  /** Sign up parent with Supabase Auth, then insert both profile rows. Returns the auth user ID and new child UUID. */
  async saveOnboarding(p: OnboardingParams): Promise<{ userId: string; childId: string }> {
    const { data: authData, error: authErr } = await supabase.auth.signUp({
      email: p.email,
      password: p.password,
    });
    if (authErr) throw authErr;
    const userId = authData.user!.id;

    // signUp() may not establish an active session (e.g. if email confirmation is
    // required, or if the client's async initialise() races ahead and clears the
    // in-memory token). signInWithPassword immediately after guarantees the client
    // holds a valid JWT before the RLS-protected inserts below.
    // insert_child uses auth.uid() for parent_id — a missing session causes not_authenticated.
    const { data: signInData, error: signInErr } = await supabase.auth.signInWithPassword({ email: p.email, password: p.password });
    if (signInErr) throw new Error('account_created_but_login_failed: ' + signInErr.message);
    const refreshToken = signInData.session?.refresh_token;
    if (refreshToken) saveParentRefreshToken(userId, refreshToken).catch(() => {});

    const { error: parentErr } = await supabase.from('parents').insert({
      id:                        userId,
      first_name:                p.parent.firstName,
      last_name:                 p.parent.lastName,
      display_name:              p.parent.displayName,
      email:                     p.email,
      mobile:                    p.parent.mobile,
      address:                   p.parent.address,
      safety_pool_limit:         p.parent.safetyPoolLimit,
      weekly_allowance:          p.parent.weeklyAllowance,
      marketing_notifications:   p.parent.marketingNotifications,
      marketing_preference_updated_at: new Date().toISOString(),
    });
    if (parentErr) throw parentErr;

    // Verify the session is established before calling insert_child.
    // The RPC uses auth.uid() for parent_id — a missing session causes not_authenticated.
    const { data: { session: preRpcSession } } = await supabase.auth.getSession();
    if (__DEV__) {
      console.log('[Breesh] insert_child pre-flight:', {
        rpc: 'insert_child',
        hasSession: !!preRpcSession,
        userId: preRpcSession?.user?.id ?? null,
        username: p.child.username,
        displayName: p.child.displayName,
        // p_password intentionally omitted
      });
    }
    if (!preRpcSession) {
      throw new Error('not_authenticated');
    }

    // insert_child RPC bcrypt-hashes the password inside the database.
    // The plain-text password travels over TLS and is never stored anywhere.
    // Returns the new child's UUID which we store so the app knows who was just created.
    const { data: newChildId, error: childErr } = await supabase.rpc('insert_child', {
      p_display_name: p.child.displayName,
      p_username:     p.child.username,
      p_password:     p.child.password,
      p_mobile:       p.child.mobile,
      p_age:          p.child.age,
      p_avatar_emoji: p.child.avatarEmoji,
    });
    if (childErr) {
      if (__DEV__) {
        console.error('[Breesh] insert_child RPC error:', {
          message: childErr.message,
          code:    childErr.code,
          details: childErr.details,
          hint:    childErr.hint,
        });
      }
      if (childErr.message?.includes('username_taken')) throw new Error('username_taken');
      if (childErr.message?.includes('not_authenticated')) throw new Error('not_authenticated');
      if (childErr.code === '42501' || childErr.message?.includes('permission denied')) {
        throw new Error('permission_denied');
      }
      throw childErr;
    }

    return { userId, childId: newChildId as string };
  },

  async checkUsernameExists(username: string): Promise<boolean> {
    const { data } = await supabase.rpc('check_username_exists', {
      p_username: username.toLowerCase().trim(),
    });
    return !!data;
  },

  async loadParent(userId: string) {
    const { data } = await supabase
      .from('parents')
      .select('*')
      .eq('id', userId)
      .single();
    return data;
  },

  async loadChild(parentId: string) {
    const { data } = await supabase
      .from('children')
      .select('*')
      .eq('parent_id', parentId)
      .single();
    return data;
  },

  async uploadParentProfileImage(userId: string, uri: string, mimeType: string): Promise<string> {
    const ext = mimeType.includes('png') ? 'png' : 'jpg';
    const path = `parent_${userId}.${ext}`;

    let arrayBuffer: ArrayBuffer;
    if (Platform.OS === 'web') {
      const resp = await fetch(uri);
      arrayBuffer = await resp.arrayBuffer();
    } else {
      const base64 = await readAsStringAsync(uri, { encoding: 'base64' });
      arrayBuffer = base64Decode(base64);
    }

    const { error: uploadErr } = await supabase.storage
      .from('avatars')
      .upload(path, arrayBuffer, { upsert: true, contentType: mimeType });
    if (uploadErr) throw new Error('upload error: ' + uploadErr.message);

    const { data } = supabase.storage.from('avatars').getPublicUrl(path);
    const publicUrl = data.publicUrl + '?t=' + Date.now();
    const { error: updateErr } = await supabase.from('parents').update({
      profile_image_url:        publicUrl,
      profile_image_updated_at: new Date().toISOString(),
    }).eq('id', userId);
    if (updateErr) throw new Error('update error: ' + updateErr.message);
    return publicUrl;
  },

  async removeParentProfileImage(userId: string): Promise<void> {
    const { error } = await supabase.from('parents').update({
      profile_image_url:        null,
      profile_image_updated_at: new Date().toISOString(),
    }).eq('id', userId);
    if (error) throw error;
  },

  async updateMarketingPreference(userId: string, value: boolean): Promise<void> {
    const { error } = await supabase.from('parents').update({
      marketing_notifications:         value,
      marketing_preference_updated_at: new Date().toISOString(),
    }).eq('id', userId);
    if (error) throw error;
  },

  async setParentPasscode(userId: string, pin: string): Promise<void> {
    if (__DEV__) {
      const { data: { session } } = await supabase.auth.getSession();
      console.log('[Passcode] setParentPasscode pre-flight:', {
        sessionExists: !!session,
        sessionUserId: session?.user?.id ?? null,
        pParentId:     userId,
        idsMatch:      session?.user?.id === userId,
      });
    }
    const { error } = await supabase.rpc('set_parent_passcode', {
      p_parent_id: userId,
      p_pin:       pin,
    });
    if (__DEV__ && error) {
      console.log('[Passcode] set_parent_passcode RPC error:', {
        code:    error.code,
        message: error.message,
        details: error.details,
        hint:    error.hint,
      });
    }
    if (error) throw error;
  },

  async searchChildren(query: string, excludeId: string, sessionToken: string, deviceId: string) {
    if (!sessionToken || !deviceId) throw new Error('invalid_child_session');
    const { data, error } = await supabase.rpc('search_children', {
      p_query:         query,
      p_exclude_id:    excludeId,
      p_session_token: sessionToken,
      p_device_id:     deviceId,
    });
    if (error) {
      if (__DEV__) console.log('[Search] RPC error — code:', error.code, 'msg:', error.message);
      const msg = error.message ?? '';
      if (msg.includes('invalid_child_session'))  throw new Error('invalid_child_session');
      if (msg.includes('child_session_expired'))  throw new Error('child_session_expired');
      if (msg.includes('child_session_revoked'))  throw new Error('child_session_revoked');
      if (error.code === '42501')                 throw new Error('permission_denied');
      throw error;
    }
    return (data ?? []) as Array<{ id: string; display_name: string; username: string; avatar_emoji: string; avatar_url: string | null; trust_score: number }>;
  },

  async sendCircleRequest(fromId: string, toId: string, sessionToken: string, deviceId: string): Promise<void> {
    if (!sessionToken || !deviceId) throw new Error('invalid_child_session');
    const { error } = await supabase.rpc('send_circle_request', {
      p_from_id: fromId, p_to_id: toId,
      p_session_token: sessionToken, p_device_id: deviceId,
    });
    if (error) throw new Error('send_circle_request error: ' + error.message);
  },

  async acceptCircleRequest(requestId: string, actingChildId: string, sessionToken: string, deviceId: string): Promise<void> {
    if (!sessionToken || !deviceId) throw new Error('invalid_child_session');
    const { error } = await supabase.rpc('accept_circle_request', {
      p_request_id: requestId, p_acting_child_id: actingChildId,
      p_session_token: sessionToken, p_device_id: deviceId,
    });
    if (error) throw new Error('accept_circle_request error: ' + error.message);
  },

  async declineCircleRequest(requestId: string, actingChildId: string, sessionToken: string, deviceId: string): Promise<void> {
    if (!sessionToken || !deviceId) throw new Error('invalid_child_session');
    const { error } = await supabase.rpc('decline_circle_request', {
      p_request_id: requestId, p_acting_child_id: actingChildId,
      p_session_token: sessionToken, p_device_id: deviceId,
    });
    if (error) throw new Error('decline_circle_request error: ' + error.message);
  },

  async getPendingRequests(childId: string, sessionToken: string, deviceId: string) {
    if (!sessionToken || !deviceId) throw new Error('invalid_child_session');
    const { data, error } = await supabase.rpc('get_pending_requests', {
      p_child_id:      childId,
      p_session_token: sessionToken,
      p_device_id:     deviceId,
    });
    if (error) throw new Error('get_pending_requests error: ' + error.message);
    return (data ?? []) as Array<{
      request_id: string; id: string; display_name: string;
      username: string; avatar_emoji: string; trust_score: number; created_at: string; avatar_url: string | null;
    }>;
  },

  async registerParentDeviceToken(
    expoPushToken: string, deviceId?: string, platform?: string, appVersion?: string,
  ): Promise<void> {
    if (__DEV__) {
      const { data: { session } } = await supabase.auth.getSession();
      console.log('[ParentAuth] sessionExists:', !!session,
        '| sessionValid:', !!(session?.access_token),
        '| uidPrefix:', session?.user?.id?.slice(0, 8) ?? 'null');
    }
    const { error } = await supabase.rpc('register_parent_device_token', {
      p_expo_push_token: expoPushToken,
      p_device_id:       deviceId ?? null,
      p_platform:        platform ?? null,
      p_app_version:     appVersion ?? null,
    });
    if (error) {
      if (__DEV__) console.warn('[ParentPush] registrationError (session path) —', error.message);
      throw new Error(error.message);
    }
  },

  /**
   * Registers a parent push token using a verified PIN instead of a Supabase Auth
   * session. Use this in the PIN-login flow (cold start / app restart) where the
   * Supabase JWT is no longer in memory.  Returns true if the PIN was correct
   * (push-token registration is best-effort and does not affect this result —
   * see register_parent_push_token_passcode's M070 header comment). Throws
   * 'rate_limit_exceeded' on too many attempts.
   */
  async registerParentPushTokenWithPasscode(
    parentId: string, pin: string, expoPushToken: string,
    deviceId?: string, platform?: string, appVersion?: string,
  ): Promise<boolean> {
    if (__DEV__) console.log('[ParentPush] registrationAttempt (passcode path) — platform:', platform ?? Platform.OS);
    const { data, error } = await supabase.rpc('register_parent_push_token_passcode', {
      p_parent_id:       parentId,
      p_pin:             pin,
      p_expo_push_token: expoPushToken,
      p_device_id:       deviceId ?? null,
      p_platform:        platform ?? null,
      p_app_version:     appVersion ?? null,
    });
    if (error) {
      if (__DEV__) console.warn('[ParentPush] registrationError (passcode path) —', error.message);
      if (error.message?.includes('rate_limit_exceeded')) throw new Error('rate_limit_exceeded');
      return false;
    }
    if (__DEV__) console.log('[ParentPush] registrationSuccess (passcode path) — registered:', !!data);
    return !!data;
  },

  async registerChildDeviceToken(
    childId: string, sessionToken: string, deviceId: string,
    expoPushToken: string, platform?: string, appVersion?: string,
  ): Promise<void> {
    const { error } = await supabase.rpc('register_child_device_token', {
      p_child_id:        childId,
      p_session_token:   sessionToken,
      p_device_id:       deviceId,
      p_expo_push_token: expoPushToken,
      p_platform:        platform ?? null,
      p_app_version:     appVersion ?? null,
    });
    if (error) throw new Error(error.message);
  },

  async deregisterParentDeviceToken(expoPushToken: string): Promise<void> {
    const { error } = await supabase.rpc('deregister_parent_device_token', {
      p_expo_push_token: expoPushToken,
    });
    if (error) throw new Error('deregister_parent_device_token error: ' + error.message);
  },

  async deregisterChildDeviceToken(
    expoPushToken: string, childId: string, sessionToken: string, deviceId: string,
  ): Promise<void> {
    const { error } = await supabase.rpc('deregister_child_device_token', {
      p_expo_push_token: expoPushToken,
      p_child_id:        childId,
      p_session_token:   sessionToken,
      p_device_id:       deviceId,
    });
    if (error) throw new Error('deregister_child_device_token error: ' + error.message);
  },

  async getCircle(childId: string, sessionToken: string, deviceId: string) {
    if (!sessionToken || !deviceId) throw new Error('invalid_child_session');
    const { data, error } = await supabase.rpc('get_circle', {
      p_child_id:      childId,
      p_session_token: sessionToken,
      p_device_id:     deviceId,
    });
    if (error) throw new Error('get_circle error: ' + error.message);
    return (data ?? []) as Array<{ id: string; display_name: string; username: string; avatar_emoji: string; trust_score: number; avatar_url: string | null }>;
  },

  async loginChild(username: string, password: string, deviceId: string) {
    const { data, error } = await supabase.rpc('login_child', {
      p_username: username.toLowerCase(),
      p_password: password,
      p_device_id: deviceId,
    });
    if (error) {
      // Server rejected because a parent session is active on this device and the
      // target child belongs to a different parent (migration 068).
      if (String(error.message).includes('not_authorized')) throw new Error('not_authorized');
      throw new Error('RPC error: ' + error.message + ' [' + error.code + ']');
    }
    if (!data) return null;
    return data as { child: Record<string, any>; parent: Record<string, any>; session_token: string; session_expires_at: string };
  },

  async createMoneyRequest(
    fromId: string, amount: number, deadlineDays: number,
    sessionToken: string, deviceId: string,
    viewerIds?: string[],
  ): Promise<{ requestId: string; pushTokens: string[] }> {
    if (!sessionToken || !deviceId) throw new Error('invalid_child_session');
    const { data, error } = await supabase.rpc('create_money_request', {
      p_from_id: fromId, p_amount: amount, p_deadline_days: deadlineDays,
      p_session_token: sessionToken, p_device_id: deviceId,
      p_reason: '', p_reason_emoji: '💸',
      p_viewer_ids: viewerIds ?? null,
    });
    if (error) throw new Error('create_money_request error: ' + error.message);
    const d = data as any;
    return { requestId: d.request_id, pushTokens: d.push_tokens ?? [] };
  },

  async getActiveRequests(childId: string, sessionToken: string, deviceId: string) {
    if (!sessionToken || !deviceId) throw new Error('invalid_child_session');
    const { data, error } = await supabase.rpc('get_active_requests', {
      p_child_id:      childId,
      p_session_token: sessionToken,
      p_device_id:     deviceId,
    });
    if (error) throw new Error('get_active_requests error: ' + error.message);
    return (data ?? []) as Array<{
      id: string; from_id: string; from_name: string; from_emoji: string;
      from_trust: number; amount: number; reason: string; reason_emoji: string;
      deadline_days: number; repay_by_date: string; expires_at: string;
      status: string; created_at: string; is_own: boolean;
      funded_by: string | null; funded_by_name: string | null; funded_by_emoji: string | null;
    }>;
  },

  async fundMoneyRequest(requestId: string, funderId: string, amount: number, sessionToken: string, deviceId: string): Promise<{ borrowerPushToken: string | null }> {
    if (!sessionToken || !deviceId) throw new Error('invalid_child_session');
    const { data, error } = await supabase.rpc('fund_money_request', {
      p_request_id: requestId, p_funder_id: funderId, p_amount: amount,
      p_session_token: sessionToken, p_device_id: deviceId,
    });
    if (error) throw new Error('fund_money_request error: ' + error.message);
    return { borrowerPushToken: (data as any)?.borrower_push_token ?? null };
  },

  async repayMoneyRequest(requestId: string, borrowerId: string, sessionToken: string, deviceId: string): Promise<{ funderPushToken: string | null; funderId: string; amount: number }> {
    if (!sessionToken || !deviceId) throw new Error('invalid_child_session');
    const { data, error } = await supabase.rpc('repay_money_request', {
      p_request_id: requestId, p_borrower_id: borrowerId,
      p_session_token: sessionToken, p_device_id: deviceId,
    });
    if (error) throw new Error('repay_money_request error: ' + error.message);
    const d = data as any;
    return { funderPushToken: d?.funder_push_token ?? null, funderId: d?.funder_id, amount: d?.amount };
  },

  async cancelMoneyRequest(requestId: string, childId: string, sessionToken: string, deviceId: string): Promise<void> {
    if (!sessionToken || !deviceId) throw new Error('invalid_child_session');
    const { error } = await supabase.rpc('cancel_money_request', {
      p_request_id: requestId, p_child_id: childId,
      p_session_token: sessionToken, p_device_id: deviceId,
    });
    if (error) throw new Error('cancel_money_request error: ' + error.message);
  },

  async enableBiometric(childId: string, deviceId: string, biometricTokenHash: string, sessionToken: string): Promise<void> {
    const { error } = await supabase.rpc('enable_biometric', {
      p_child_id: childId, p_device_id: deviceId, p_biometric_token_hash: biometricTokenHash,
      p_session_token: sessionToken,
    });
    if (error) throw new Error('enable_biometric error: ' + error.message);
  },

  async disableBiometric(childId: string, sessionToken: string, deviceId: string): Promise<void> {
    const { error } = await supabase.rpc('disable_biometric', {
      p_child_id: childId, p_session_token: sessionToken, p_device_id: deviceId,
    });
    if (error) throw new Error('disable_biometric error: ' + error.message);
  },

  async biometricLoginChild(childId: string, deviceId: string, biometricToken: string): Promise<{ child: any; parent: any; session_token: string; session_expires_at: string } | null> {
    const { data, error } = await supabase.rpc('biometric_login_child', {
      p_child_id: childId, p_device_id: deviceId, p_biometric_token: biometricToken,
    });
    if (error) {
      if (String(error.message).includes('not_authorized')) throw new Error('not_authorized');
      throw new Error('biometric_login_child error: ' + error.message);
    }
    return data ?? null;
  },

  async revokeChildSession(sessionToken: string): Promise<void> {
    await supabase.rpc('revoke_child_session', { p_session_token: sessionToken });
  },

  async cancelCircleRequest(fromId: string, toId: string, sessionToken: string, deviceId: string): Promise<void> {
    if (!sessionToken || !deviceId) throw new Error('invalid_child_session');
    const { error } = await supabase.rpc('cancel_circle_request', {
      p_from_id: fromId, p_to_id: toId,
      p_session_token: sessionToken, p_device_id: deviceId,
    });
    if (error) throw new Error('cancel_circle_request error: ' + error.message);
  },

  async getOutgoingPendingRequests(childId: string, sessionToken: string, deviceId: string) {
    if (!sessionToken || !deviceId) throw new Error('invalid_child_session');
    const { data, error } = await supabase.rpc('get_outgoing_pending_requests', {
      p_child_id:      childId,
      p_session_token: sessionToken,
      p_device_id:     deviceId,
    });
    if (error) throw new Error('get_outgoing_pending_requests error: ' + error.message);
    return (data ?? []) as Array<{ id: string }>;
  },

  async getResolvedSentRequests(childId: string, sessionToken: string, deviceId: string) {
    if (!sessionToken || !deviceId) throw new Error('invalid_child_session');
    const { data, error } = await supabase.rpc('get_resolved_sent_requests', {
      p_child_id:      childId,
      p_session_token: sessionToken,
      p_device_id:     deviceId,
    });
    if (error) throw new Error('get_resolved_sent_requests error: ' + error.message);
    return (data ?? []) as Array<{ request_id: string; id: string; display_name: string; username: string; avatar_emoji: string; status: string; created_at: string }>;
  },

  async getActivityFeed(childId: string, sessionToken: string, deviceId: string, limit = 100) {
    if (!sessionToken || !deviceId) throw new Error('invalid_child_session');
    const { data, error } = await supabase.rpc('get_activity_feed', {
      p_child_id:      childId,
      p_session_token: sessionToken,
      p_device_id:     deviceId,
      p_limit:         limit,
    });
    if (error) throw new Error('get_activity_feed error: ' + error.message);
    return (data ?? []) as Array<{ id: string; emoji: string; text: string; type: string; created_at: string }>;
  },

  async getChildTransactions(childId: string, sessionToken: string, deviceId: string, limit = 20) {
    if (!sessionToken || !deviceId) throw new Error('invalid_child_session');
    const { data, error } = await supabase.rpc('get_child_transactions', {
      p_child_id:      childId,
      p_session_token: sessionToken,
      p_device_id:     deviceId,
      p_limit:         limit,
    });
    if (error) throw new Error('get_child_transactions error: ' + error.message);
    return (data ?? []) as Array<{
      id: string; type: string; amount: number;
      description: string; counterparty: string | null; created_at: string;
    }>;
  },

  async getChildStats(childId: string, sessionToken: string, deviceId: string) {
    if (!sessionToken || !deviceId) throw new Error('invalid_child_session');
    const { data, error } = await supabase.rpc('get_child_stats', {
      p_child_id:      childId,
      p_session_token: sessionToken,
      p_device_id:     deviceId,
    });
    if (error) throw new Error('get_child_stats error: ' + error.message);
    return data as { wallet_balance: number; loaned_out: number; borrowed: number; trust_score: number; points: number; streak: number; repaid: number; missed: number; total_borrowed: number; total_lent: number; times_borrowed: number; times_lent: number; profile_image_url: string | null; account_frozen: boolean; parent_debt: number } | null;
  },

  async uploadProfileImage(
    childId: string, uri: string, mimeType: string,
    sessionToken: string, deviceId: string,
  ): Promise<string> {
    const ext = mimeType.includes('png') ? 'png' : 'jpg';
    const path = `child_${childId}.${ext}`;

    let arrayBuffer: ArrayBuffer;
    if (Platform.OS === 'web') {
      const resp = await fetch(uri);
      arrayBuffer = await resp.arrayBuffer();
    } else {
      const base64 = await readAsStringAsync(uri, { encoding: 'base64' });
      arrayBuffer = base64Decode(base64);
    }

    const { error: uploadErr } = await supabase.storage
      .from('avatars')
      .upload(path, arrayBuffer, { upsert: true, contentType: mimeType });
    if (uploadErr) throw new Error('upload error: ' + uploadErr.message);

    const { data } = supabase.storage.from('avatars').getPublicUrl(path);
    const publicUrl = data.publicUrl + '?t=' + Date.now();
    const { error: updateErr } = await supabase.rpc('update_profile_image', {
      p_child_id:      childId,
      p_image_url:     publicUrl,
      p_session_token: sessionToken,
      p_device_id:     deviceId,
    });
    if (updateErr) throw new Error('update error: ' + updateErr.message);
    return publicUrl;
  },

  async updateChildAvatarEmoji(childId: string, emoji: string): Promise<void> {
    const { error } = await supabase
      .from('children')
      .update({ avatar_emoji: emoji })
      .eq('id', childId);
    if (error) throw error;
  },

  async removeFromCircle(childId: string, friendId: string, sessionToken: string, deviceId: string): Promise<void> {
    if (!sessionToken || !deviceId) throw new Error('invalid_child_session');
    const { error } = await supabase.rpc('remove_from_circle', {
      p_child_id: childId, p_friend_id: friendId,
      p_session_token: sessionToken, p_device_id: deviceId,
    });
    if (error) throw new Error('remove_from_circle error: ' + error.message);
  },

  /** Atomically add `amount` to the existing safety pool balance. Returns new total. */
  async topUpSafetyPool(userId: string, amount: number): Promise<number> {
    const { data, error } = await supabase.rpc('top_up_safety_pool', {
      p_parent_id: userId,
      p_amount:    amount,
    });
    if (error) throw error;
    return data as number;
  },

  /** Persist allowance settings. nextPayment is an ISO date string or null. */
  async updateAllowance(
    userId: string,
    amount: number,
    frequency: string,
    nextPayment: string | null,
    active: boolean,
  ): Promise<void> {
    const { error } = await supabase
      .from('parents')
      .update({
        weekly_allowance:        amount,
        allowance_frequency:     frequency,
        allowance_next_payment:  nextPayment,
        allowance_active:        active,
      })
      .eq('id', userId);
    if (error) throw error;
  },

  /** Verify a parent PIN server-side — the hash never leaves the DB.
   *  Throws 'rate_limit_exceeded' when too many failed attempts have been made.
   */
  async verifyParentPasscode(userId: string, pin: string): Promise<boolean> {
    const { data, error } = await supabase.rpc('verify_parent_passcode', {
      p_parent_id: userId,
      p_pin:       pin,
    });
    if (error?.message?.includes('rate_limit_exceeded')) {
      throw new Error('rate_limit_exceeded');
    }
    return !!data;
  },

  /** Fetch live Safety Pool balance from DB — used by the access guard.
   *  Requires an active parent Supabase Auth session; returns null if the
   *  caller is unauthenticated or not the parent identified by userId.
   */
  async getSafetyPoolStatus(userId: string): Promise<{ limit: number; used: number } | null> {
    const { data } = await supabase
      .rpc('get_parent_safety_pool_status', { p_parent_id: userId })
      .single();
    if (!data) return null;
    return {
      limit: Number((data as any).pool_limit ?? 0),
      used:  Number((data as any).pool_used  ?? 0),
    };
  },

  /** Refresh parent financial data from DB (safety pool, allowance). */
  async getParentStats(userId: string) {
    const { data } = await supabase
      .from('parents')
      .select('safety_pool_limit, safety_pool_used, weekly_allowance, allowance_frequency, allowance_next_payment, allowance_active')
      .eq('id', userId)
      .single();
    return data as {
      safety_pool_limit:      number;
      safety_pool_used:       number;
      weekly_allowance:       number;
      allowance_frequency:    string;
      allowance_next_payment: string | null;
      allowance_active:       boolean;
    } | null;
  },

  async loginParent(email: string, password: string) {
    const { data: authData, error: authErr } = await supabase.auth.signInWithPassword({ email, password });
    if (authErr || !authData.user) return null;
    const userId = authData.user.id;
    const refreshToken = authData.session?.refresh_token;
    if (refreshToken) saveParentRefreshToken(userId, refreshToken).catch(() => {});
    const { data: parentData } = await supabase
      .from('parents')
      .select('id, first_name, last_name, display_name, mobile, address, safety_pool_limit, safety_pool_used, weekly_allowance, allowance_frequency, allowance_next_payment, allowance_active, passcode_created, marketing_notifications, profile_image_url')
      .eq('id', userId)
      .single();
    const { data: childData } = await supabase
      .from('children')
      .select('id, display_name, username, avatar_emoji, profile_image_url, trust_score, wallet_balance, loaned_out, borrowed, streak, repaid, missed, total_borrowed, total_lent, times_borrowed, times_lent, points, age, mobile, account_frozen, parent_debt')
      .eq('parent_id', userId)
      .single();
    if (!parentData) return null;
    return { userId, parent: parentData, child: childData };
  },

  async checkEmailExists(email: string): Promise<boolean> {
    const { data } = await supabase.rpc('check_email_exists', { p_email: email.toLowerCase() });
    return !!data;
  },

  async checkMobileExists(mobile: string): Promise<boolean> {
    const { data } = await supabase.rpc('check_mobile_exists', { p_mobile: mobile.trim() });
    return !!data;
  },

  /**
   * Parent sends money directly to child's wallet.
   * Requires the `parent_send_to_child` SECURITY DEFINER function in Supabase.
   *
   * SQL to create it:
   *
   * CREATE OR REPLACE FUNCTION parent_send_to_child(
   *   p_user_id uuid, p_child_id uuid, p_amount numeric, p_parent_name text
   * ) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
   * DECLARE v_tx_id text := 'ps_' || floor(extract(epoch from now()))::bigint;
   * BEGIN
   *   IF NOT EXISTS (SELECT 1 FROM children WHERE id = p_child_id AND parent_id = p_user_id)
   *     THEN RAISE EXCEPTION 'not_parent'; END IF;
   *   UPDATE children SET wallet_balance = wallet_balance + p_amount WHERE id = p_child_id;
   *   INSERT INTO transactions (child_id, type, amount, description, counterparty)
   *     VALUES (p_child_id, 'topup', p_amount, 'Money from ' || p_parent_name, p_parent_name);
   *   INSERT INTO activity_feed (child_id, id, emoji, text, type)
   *     VALUES (p_child_id, 'act_' || v_tx_id, '💸',
   *             p_parent_name || ' sent you £' || round(p_amount, 2)::text, 'topup');
   * END; $$;
   */
  async parentSendToChild(userId: string, childId: string, amount: number, parentName: string): Promise<void> {
    const { error } = await supabase.rpc('parent_send_to_child', {
      p_user_id: userId,
      p_child_id: childId,
      p_amount: amount,
      p_parent_name: parentName,
    });
    if (error) throw new Error(error.message);
  },

  async getLoanHistory(childId: string, sessionToken: string, deviceId: string) {
    if (!sessionToken || !deviceId) throw new Error('invalid_child_session');
    const { data, error } = await supabase.rpc('get_loan_history', {
      p_child_id:      childId,
      p_session_token: sessionToken,
      p_device_id:     deviceId,
    });
    if (error) throw new Error('get_loan_history error: ' + error.message);
    return (data ?? []) as Array<{
      id: string;
      amount: number;
      reason: string;
      reason_emoji: string;
      created_at: string;
      repaid_at: string | null;
      repay_by_date: string;
      is_borrower: boolean;
      repaid_on_time: boolean;
      borrower_name: string;
      borrower_username: string;
      borrower_emoji: string;
      borrower_avatar_url: string | null;
      funder_name: string;
      funder_username: string;
      funder_emoji: string;
      funder_avatar_url: string | null;
    }>;
  },

  async getCircleHistory(childId: string, sessionToken: string, deviceId: string) {
    if (!sessionToken || !deviceId) throw new Error('invalid_child_session');
    const { data, error } = await supabase.rpc('get_circle_history', {
      p_child_id:      childId,
      p_session_token: sessionToken,
      p_device_id:     deviceId,
    });
    if (error) throw new Error('get_circle_history error: ' + error.message);
    return (data ?? []) as Array<{
      id: string; amount: number; reason: string; reason_emoji: string;
      created_at: string; repay_by_date: string; is_borrower: boolean;
      borrower_name: string; borrower_emoji: string; borrower_url: string | null;
      funder_name: string; funder_emoji: string; funder_url: string | null;
    }>;
  },

  async recordWeeklyStreak(childId: string): Promise<number> {
    const { data, error } = await supabase.rpc('record_weekly_streak', { p_child_id: childId });
    if (error) return 0;
    return (data as any)?.new_streak ?? 0;
  },

  /** Expires streak to 0 if no qualifying activity in the past ISO week. Call at login. */
  async checkStreakExpiry(childId: string): Promise<number> {
    const { data, error } = await supabase.rpc('check_streak_expiry', { p_child_id: childId });
    if (error) return -1;
    return (data as any)?.streak ?? -1;
  },

  /** Parent confirms child repaid: clears parent_debt, restores safety pool, unfreezes account. */
  async confirmParentRepayment(childId: string, parentId: string): Promise<void> {
    const { error } = await supabase.rpc('confirm_parent_repayment', {
      p_child_id: childId, p_parent_id: parentId,
    });
    if (error) throw new Error(error.message);
  },

  // ── M049: Block & Report ────────────────────────────────────────────────────

  /** Block a user. Silently declines any pending circle requests and removes
   *  active friendship. Funded loans are preserved (financial obligation survives). */
  async blockUser(
    blockerId: string, sessionToken: string, deviceId: string, blockedId: string,
  ): Promise<void> {
    const { error } = await supabase.rpc('block_user', {
      p_blocker_id:    blockerId,
      p_session_token: sessionToken,
      p_device_id:     deviceId,
      p_blocked_id:    blockedId,
    });
    if (error) throw new Error(error.message);
  },

  /** Remove a previously placed block. */
  async unblockUser(
    blockerId: string, sessionToken: string, deviceId: string, blockedId: string,
  ): Promise<void> {
    const { error } = await supabase.rpc('unblock_user', {
      p_blocker_id:    blockerId,
      p_session_token: sessionToken,
      p_device_id:     deviceId,
      p_blocked_id:    blockedId,
    });
    if (error) throw new Error(error.message);
  },

  /** Submit a report against another user.
   *  Duplicate (same reporter + reported + reason) is silently ignored server-side. */
  async reportUser(
    reporterId: string, sessionToken: string, deviceId: string,
    reportedId: string, reason: string, description?: string,
  ): Promise<void> {
    const { error } = await supabase.rpc('report_user', {
      p_reporter_id:   reporterId,
      p_session_token: sessionToken,
      p_device_id:     deviceId,
      p_reported_id:   reportedId,
      p_reason:        reason,
      p_description:   description ?? null,
    });
    if (error) throw new Error(error.message);
  },

  /** Returns the list of users blocked by the caller. */
  async getBlockedUsers(
    childId: string, sessionToken: string, deviceId: string,
  ): Promise<Array<{ id: string; display_name: string; username: string; avatar_emoji: string }>> {
    const { data, error } = await supabase.rpc('get_blocked_users', {
      p_child_id:      childId,
      p_session_token: sessionToken,
      p_device_id:     deviceId,
    });
    if (error) throw new Error(error.message);
    return (data ?? []) as Array<{ id: string; display_name: string; username: string; avatar_emoji: string }>;
  },

  // ── M062: Reward catalog & redemption ──────────────────────────────────────

  async getGiftCardCatalog(
    childId: string, sessionToken: string, deviceId: string,
  ): Promise<Array<{ id: string; name: string; brand: string; cost_pts: number; sort_order: number }>> {
    const { data, error } = await supabase.rpc('get_gift_card_catalog', {
      p_child_id:      childId,
      p_session_token: sessionToken,
      p_device_id:     deviceId,
    });
    if (error) throw new Error('get_gift_card_catalog: ' + error.message);
    return (data ?? []) as Array<{ id: string; name: string; brand: string; cost_pts: number; sort_order: number }>;
  },

  async redeemGiftCard(
    childId: string, catalogId: string, sessionToken: string, deviceId: string,
  ): Promise<{ redemption_id: string; reward_name: string; points_spent: number }> {
    const { data, error } = await supabase.rpc('redeem_gift_card', {
      p_child_id:      childId,
      p_catalog_id:    catalogId,
      p_session_token: sessionToken,
      p_device_id:     deviceId,
    });
    if (error) throw new Error(error.message);
    return data as { redemption_id: string; reward_name: string; points_spent: number };
  },
};
