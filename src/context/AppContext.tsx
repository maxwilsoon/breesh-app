import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { cache } from '../lib/cache';
import { db } from '../lib/database';
import { fmtAmt } from '../lib/utils';
import {
  setLastParentForPasscode, getLastParentForPasscode, getDeviceId,
  getLastChildForBiometric, isBiometricAvailable, hasBiometricForChild,
} from '../lib/biometrics';
import { saveChildSession, getChildSession, clearChildSession } from '../lib/childSession';
import { deregisterCurrentPushToken, registerPushToken } from '../lib/notifications';
import { navigationRef } from '../navigation';
import { supabase } from '../lib/supabase';

export type CardNetwork = 'visa' | 'mastercard' | 'amex' | 'other';

export interface PaymentMethod {
  id: string;
  type: 'card' | 'bank';
  label: string;        // e.g. "Visa" / "Barclays"
  last4: string;
  expiry?: string;      // MM/YY — cards only
  network?: CardNetwork;
  sortCode?: string;    // banks only
  isDefault: boolean;
}

export interface CircleMember {
  id: string;
  displayName: string;
  username: string;
  avatarEmoji: string;
  trustScore: number;
  profileImageUrl?: string;
}

export interface Transaction {
  id: string;
  type: 'borrow' | 'lend' | 'repay' | 'receive' | 'topup' | 'spend' | 'allowance' | 'parent_transfer';
  amount: number;
  description: string;
  date: string;
  counterparty?: string;
  status: 'pending' | 'active' | 'completed' | 'missed';
}

export interface ActiveRequest {
  id: string;
  fromId: string;
  fromName: string;
  fromEmoji: string;
  fromTrust: number;
  amount: number;
  reason: string;
  reasonEmoji: string;
  deadline: string;
  repayByDate: string;
  expiresIn: number;
  createdAt: string;
  isOwn?: boolean;
  isFunded?: boolean;
  fundedById?: string;
  fundedByName?: string;
  fundedByEmoji?: string;
}

export interface PendingRequest {
  requestId: string;
  id: string;
  displayName: string;
  username: string;
  avatarEmoji: string;
  trustScore: number;
  createdAt: string;
  profileImageUrl?: string;
}

export interface ActivityItem {
  id: string;
  emoji: string;
  text: string;
  time: string;
  type: 'request' | 'funded' | 'repaid' | 'missed' | 'joined' | 'tier' | 'topup' | 'spend';
  createdAt?: string; // ISO timestamp — used for sort order
}

interface ChildProfile {
  displayName: string;
  username: string;
  avatarEmoji: string;
  trustScore: number;
  balance: number;   // liquid cash in wallet
  loanedOut: number; // money lent TO friends (they owe this back to you)
  borrowed: number;  // money borrowed FROM friends (you owe this back to them)
  streak: number;
  repaid: number;
  missed: number;
  totalBorrowed: number;
  totalLent: number;
  timesBorrowed: number;
  timesLent: number;
  points: number;
  age: number;
  mobile: string;
  email: string;
  profileImageUrl?: string;
  biometricEnabled: boolean;
}

interface ParentProfile {
  firstName: string;
  lastName: string;
  displayName: string;
  email: string;
  mobile: string;
  address: string;
  safetyPoolLimit: number;
  safetyPoolUsed: number;
  weeklyAllowance: number;
  allowanceFrequency: string;    // 'weekly' | 'fortnightly' | 'monthly'
  allowanceNextPayment: string;  // ISO date string or ''
  allowanceActive: boolean;
  passcodeCreated: boolean;      // true once a passcode has been set up
  marketingNotifications: boolean;
  profileImageUrl?: string;
}

interface AppContextType {
  paymentMethods: PaymentMethod[];
  addPaymentMethod: (m: PaymentMethod) => void;
  removePaymentMethod: (id: string) => void;
  setDefaultPaymentMethod: (id: string) => void;
  isOnboarded: boolean;
  setIsOnboarded: (v: boolean) => void;
  // True once the initial AsyncStorage/SecureStore hydration has finished.
  authHydrated: boolean;
  // True when that hydration found a previously logged-in account on this device
  // (a parent UUID or a child UUID) — used to route cold starts to
  // "Who's logging in?" instead of the onboarding carousel.
  hasStoredAccount: boolean;
  isChildLoggedIn: boolean;
  setIsChildLoggedIn: (v: boolean) => void;
  child: ChildProfile;
  setChild: React.Dispatch<React.SetStateAction<ChildProfile>>;
  childId: string | null;
  setChildId: (id: string | null) => void;
  pendingRequests: PendingRequest[];
  setPendingRequests: React.Dispatch<React.SetStateAction<PendingRequest[]>>;
  parent: ParentProfile;
  setParent: React.Dispatch<React.SetStateAction<ParentProfile>>;
  circle: CircleMember[];
  setCircle: React.Dispatch<React.SetStateAction<CircleMember[]>>;
  transactions: Transaction[];
  activeRequests: ActiveRequest[];
  setActiveRequests: React.Dispatch<React.SetStateAction<ActiveRequest[]>>;
  activityFeed: ActivityItem[];
  activityFetching: boolean;
  addActivity: (item: ActivityItem) => void;
  removeActivity: (id: string) => void;
  frozenAccount: boolean;
  setFrozenAccount: (v: boolean) => void;
  parentDebt: number;
  setParentDebt: (v: number) => void;
  adjustTrustScore: (delta: number) => void;
  repayOnTime: () => void;
  lendMoney: () => void;
  missRepayment: (amount: number) => void;
  repayParent: () => void;
  addTransaction: (t: Transaction) => void;
  userId: string | null;
  setUserId: (id: string | null) => void;
  setOnboardingPassword: (pw: string) => void;
  saveOnboardingToDb: (childOverride?: { displayName?: string; username?: string; password?: string; mobile?: string; age?: number }) => Promise<void>;
  savePasscodeToDb: (passcode: string) => Promise<void>;
  topUpSafetyPool: (amount: number) => Promise<void>;
  saveAllowanceToDb: (amount: number, frequency: string, nextPayment: string | null, active: boolean) => Promise<void>;
  setMarketingNotifications: (value: boolean) => Promise<void>;
  recordWeeklyStreak: () => Promise<void>;
  biometricEnabled: boolean;
  setBiometricEnabled: (v: boolean) => void;
  repayHighlightId: string | null;
  setRepayHighlightId: (id: string | null) => void;
  childSessionToken: string | null;
  setChildSessionToken: (token: string | null) => void;
  childDeviceId: string | null;
  handleSessionError: (code: string) => void;
  // One-shot flag: set when a session error lands the user back on
  // "Who's logging in?" with no biometric fallback available. Consumed by
  // WhoIsLoggingInScreen the next time it routes to ChildLogin, so the
  // "Your session expired" banner still shows without auto-navigating there.
  sessionExpiredNotice: boolean;
  clearSessionExpiredNotice: () => void;
  resetSession: () => Promise<void>;
  // Session-timeout logout: ends the live parent + child sessions and sends the
  // user back to "Who's logging in?", but keeps the cached parent/child profiles
  // so the account tiles still render and the user re-authenticates with PIN /
  // Face ID. Lighter than resetSession() — mirrors the manual logout buttons.
  autoLogout: () => Promise<void>;
}

const defaultCircle: CircleMember[] = [];
const defaultTransactions: Transaction[] = [];
const defaultRequests: ActiveRequest[] = [];
const defaultActivity: ActivityItem[] = [];

const AppContext = createContext<AppContextType>({} as AppContextType);

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([]);

  const addPaymentMethod = (m: PaymentMethod) =>
    setPaymentMethods(prev => prev.some(p => p.id === m.id) ? prev : [...prev, m]);

  const removePaymentMethod = (id: string) =>
    setPaymentMethods(prev => prev.filter(p => p.id !== id));

  const setDefaultPaymentMethod = (id: string) =>
    setPaymentMethods(prev => prev.map(p => ({ ...p, isDefault: p.id === id })));

  const [isOnboarded, setIsOnboarded] = useState(false);
  const [isChildLoggedIn, setIsChildLoggedIn] = useState(false);
  const [authHydrated, setAuthHydrated] = useState(false);
  const [hasStoredAccount, setHasStoredAccount] = useState(false);
  const [frozenAccount, setFrozenAccount] = useState(false);
  const [parentDebt, setParentDebt] = useState(0);
  const [circle, setCircle] = useState<CircleMember[]>(defaultCircle);
  const [childId, setChildId] = useState<string | null>(null);
  const [sessionExpiredNotice, setSessionExpiredNotice] = useState(false);
  const clearSessionExpiredNotice = () => setSessionExpiredNotice(false);
  const [pendingRequests, setPendingRequests] = useState<PendingRequest[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>(defaultTransactions);
  const [activeRequests, setActiveRequests] = useState<ActiveRequest[]>(defaultRequests);
  const [activityFeed, setActivityFeed] = useState<ActivityItem[]>(defaultActivity);
  const [activityFetching, setActivityFetching] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);

  const [child, setChild] = useState<ChildProfile>({
    displayName: '',
    username: '',
    avatarEmoji: '😊',
    trustScore: 50,
    balance: 0,
    loanedOut: 0,
    borrowed: 0,
    streak: 0,
    repaid: 0,
    missed: 0,
    totalBorrowed: 0,
    totalLent: 0,
    timesBorrowed: 0,
    timesLent: 0,
    points: 0,
    age: 16,
    mobile: '',
    email: '',
    biometricEnabled: false,
  });

  const [biometricEnabled, setBiometricEnabled] = useState(false);
  const [repayHighlightId, setRepayHighlightId] = useState<string | null>(null);
  const [childSessionToken, setChildSessionToken] = useState<string | null>(null);
  const [childDeviceId, setChildDeviceId] = useState<string | null>(null);

  // Holds the parent's Supabase Auth password only for the duration of onboarding.
  // Never stored in state, never written to AsyncStorage, cleared after signUp completes.
  const pendingPasswordRef = useRef<string>('');
  const setOnboardingPassword = (pw: string) => { pendingPasswordRef.current = pw; };

  const [parent, setParent] = useState<ParentProfile>({
    firstName: '',
    lastName: '',
    displayName: '',
    email: '',
    mobile: '',
    address: '',
    safetyPoolLimit: 0,
    safetyPoolUsed: 0,
    weeklyAllowance: 10,
    allowanceFrequency: 'weekly',
    allowanceNextPayment: '',
    allowanceActive: false,
    passcodeCreated: false,
    marketingNotifications: false,
  });

  // Tracks whether the initial AsyncStorage hydration has completed.
  // Cache writes are gated on this so the in-memory defaults never
  // overwrite real cached data on the first render.
  const hydrated = useRef(false);
  const childIdRef = useRef<string | null>(null);
  const childSessionTokenRef = useRef<string | null>(null);
  const childDeviceIdRef = useRef<string | null>(null);
  // Always points to the current handleSessionError — used by poll() to avoid stale closure.
  const handleSessionErrorRef = useRef<(code: string) => void>(() => {});

  // Activity feed merge helpers — reset when childId changes (new session).
  // persistedActivityIds: IDs that have ever appeared in a DB response.
  //   If an ID was in DB before but is now missing, it was deleted → remove from state.
  // activeRequestIds: currently-active request IDs (pending or funded).
  //   If a moneyreq_*/a_req_* item's request is gone from this set and has no
  //   completion events in the feed, the request was cancelled → remove from state.
  //   null = not yet loaded (skip the filter to avoid false removals on first load).
  const persistedActivityIdsRef = useRef(new Set<string>());
  const activeRequestIdsRef = useRef<Set<string> | null>(null);

  // Hydrate from local cache on mount (instant), then background-sync from DB.
  useEffect(() => {
    const hydrate = async () => {
      const [cachedParent, cachedChild, cachedUserId] = await Promise.all([
        cache.loadParent<Partial<typeof parent>>(),
        cache.loadChild<Partial<typeof child> & { childId?: string }>(),
        cache.loadUserId(),
      ]);
      if (cachedParent) setParent(p => ({ ...p, ...cachedParent }));
      let hydratedChildId: string | null = null;
      if (cachedChild) {
        // Strip any plain-text password that may exist in caches written before
        // migration 006. The password field was removed from ChildProfile in that
        // migration — having it in cache state would expose a stale plain-text value.
        const { password: _stripped, ...safeChildCache } = cachedChild as any;
        setChild(c => ({ ...c, ...safeChildCache }));
        if (cachedChild.childId) {
          hydratedChildId = cachedChild.childId;
          // Do NOT call setChildId here — defer until session token and device ID are
          // also loaded, so React 18 can batch all three into one render.  If setChildId
          // fires first, the polling effect triggers before the refs are populated and
          // the first poll() call silently skips (token/devId still null).
        }
      }
      let resolvedParentId: string | null = cachedUserId ?? null;
      if (cachedUserId) {
        setUserId(cachedUserId);
      } else {
        // AsyncStorage cache miss (old cache format, reinstall, or first launch).
        // SecureStore is not cleared by cache.clear() or app reinstall on Android —
        // use the persisted parent UUID as a fallback so PasscodeScreen can identify
        // the parent for PIN verification without requiring a fresh email login.
        const secureParentId = await getLastParentForPasscode();
        if (secureParentId) {
          setUserId(secureParentId);
          resolvedParentId = secureParentId;
        }
      }
      // Load session token, device ID, and cached activity feed in parallel.
      // All three state updates are deferred until here so React 18 can batch them
      // into one render — refs are populated before the first poll() fires.
      const [stored, devId, cachedActivity] = await Promise.all([
        hydratedChildId ? getChildSession(hydratedChildId) : Promise.resolve(null),
        getDeviceId(),
        hydratedChildId ? cache.loadActivityFeed(hydratedChildId) : Promise.resolve(null),
      ]);
      const hydratedSessionToken = (stored as any)?.token ?? null;
      hydrated.current = true;
      // A parent or child account is remembered on this device → cold starts should
      // land on "Who's logging in?" (still PIN/Face ID gated), not the carousel.
      setHasStoredAccount(!!(resolvedParentId || hydratedChildId));
      setAuthHydrated(true);
      // Batch all state updates synchronously — React 18 merges into one render.
      if (cachedActivity?.length) setActivityFeed(cachedActivity as ActivityItem[]);
      if (hydratedChildId) setChildId(hydratedChildId);
      if (hydratedSessionToken) setChildSessionToken(hydratedSessionToken);
      setChildDeviceId(devId);
      if (hydratedChildId && hydratedSessionToken && devId) {
        if (__DEV__) {
          console.log('[ChildAuth] sessionExists:', true,
            '| sessionIdPrefix:', hydratedSessionToken.slice(0, 8),
            '| deviceId present:', !!devId);
        }
        registerPushToken(hydratedChildId, 'child', hydratedSessionToken, devId)
          .catch((e: any) => {
            const msg: string = e?.message ?? '';
            if (
              msg.includes('child_session_revoked') ||
              msg.includes('child_session_expired') ||
              msg.includes('invalid_child_session')
            ) {
              // Stale session in SecureStore — clear it and route to login.
              // handleSessionErrorRef calls clearSessionState which calls clearChildSession.
              handleSessionErrorRef.current(msg);
            }
          });
      }
    };
    // Never leave the app stuck on the boot splash if hydration throws —
    // fall through to the carousel (treated as a fresh install).
    hydrate().catch(() => setAuthHydrated(true));
  }, []);

  // Keep the local cache in sync after every state update.
  useEffect(() => { if (hydrated.current) cache.saveParent(parent); }, [parent]);
  useEffect(() => {
    if (hydrated.current) {
      // Always persist childId alongside child data so it survives polling updates
      cache.saveChild({ ...child, ...(childId ? { childId } : {}) });
    }
  }, [child, childId]);
  useEffect(() => { childIdRef.current = childId; }, [childId]);
  useEffect(() => { childSessionTokenRef.current = childSessionToken; }, [childSessionToken]);
  useEffect(() => { childDeviceIdRef.current = childDeviceId; }, [childDeviceId]);

  const adjustTrustScore = (delta: number) => {
    setChild(c => ({
      ...c,
      trustScore: Math.max(0, Math.min(100, c.trustScore + delta)),
      points: Math.max(0, c.points + delta),
    }));
  };

  const repayOnTime = () => {
    setChild(c => ({
      ...c,
      trustScore: Math.min(100, c.trustScore + 5),
      points: Math.max(0, c.points + 5),
      repaid: c.repaid + 1,
    }));
  };

  const lendMoney = () => {
    setChild(c => ({
      ...c,
      trustScore: Math.min(100, c.trustScore + 2),
      points: Math.max(0, c.points + 2),
    }));
  };

  // Calls the DB's weekly streak RPC and updates local streak from the result.
  const recordWeeklyStreak = async () => {
    if (!childIdRef.current) return;
    const newStreak = await db.recordWeeklyStreak(childIdRef.current);
    if (newStreak > 0) {
      setChild(c => ({ ...c, streak: newStreak }));
    }
  };

  const missRepayment = (amount: number) => {
    setFrozenAccount(true);
    setParentDebt(amount);
    setChild(c => ({
      ...c,
      trustScore: Math.max(0, c.trustScore - 15),
      points: Math.max(0, c.points - 15),
      streak: 0,
      missed: c.missed + 1,
      borrowed: Math.max(0, c.borrowed - amount), // parent safety pool covers it
    }));
    setParent(p => ({
      ...p,
      safetyPoolUsed: Math.min(p.safetyPoolLimit, p.safetyPoolUsed + amount),
    }));
  };

  const repayParent = () => {
    const debt = parentDebt;
    // Optimistic update
    setChild(c => ({ ...c, balance: Math.max(0, c.balance - debt) }));
    setParent(p => ({ ...p, safetyPoolUsed: Math.max(0, p.safetyPoolUsed - debt) }));
    setParentDebt(0);
    setFrozenAccount(false);
    // Persist: clear parent_debt, restore safety pool, unfreeze in DB
    if (childIdRef.current && userId) {
      db.confirmParentRepayment(childIdRef.current, userId).catch(err =>
        console.warn('[Breesh] confirmParentRepayment failed:', err)
      );
    }
  };

  const addTransaction = (t: Transaction) => {
    setTransactions(prev => [t, ...prev]);
  };

  const addActivity = (item: ActivityItem) => {
    const stamped = { ...item, createdAt: item.createdAt ?? new Date().toISOString() };
    setActivityFeed(prev => {
      if (prev.some(a => a.id === stamped.id)) return prev;
      return [stamped, ...prev];
    });
  };

  const removeActivity = (id: string) => {
    setActivityFeed(prev => prev.filter(a => a.id !== id));
  };

  const saveOnboardingToDb = async (childOverride?: { displayName?: string; username?: string; password?: string; mobile?: string; age?: number }) => {
    const { userId: uid, childId: newChildId } = await db.saveOnboarding({
      email:    parent.email,
      password: pendingPasswordRef.current,
      parent: {
        firstName:              parent.firstName,
        lastName:               parent.lastName,
        displayName:            parent.displayName,
        mobile:                 parent.mobile,
        address:                parent.address,
        safetyPoolLimit:        parent.safetyPoolLimit,
        weeklyAllowance:        parent.weeklyAllowance,
        marketingNotifications: parent.marketingNotifications,
      },
      child: {
        displayName:   childOverride?.displayName   ?? child.displayName,
        username:      childOverride?.username      ?? child.username,
        password:      childOverride?.password      ?? '',
        mobile:        childOverride?.mobile        ?? child.mobile,
        age:           childOverride?.age           ?? child.age,
        avatarEmoji:   child.avatarEmoji,
        trustScore:    50,
        balance:       0,
        loanedOut:     0,
        borrowed:      0,
        streak:        0,
        repaid:        0,
        missed:        0,
        totalBorrowed: 0,
        totalLent:     0,
        points:        0,
      },
    });
    setUserId(uid);
    await cache.saveUserId(uid);
    setLastParentForPasscode(uid).catch(() => {});
    // Erase the transient onboarding password from memory — it was only needed for signUp.
    pendingPasswordRef.current = '';
    // Store the new child's UUID so the rest of the session knows who was just created.
    if (newChildId) setChildId(newChildId);
    // New account has no passcode yet. Clear any stale passcode data that
    // may have been left in cache from a previous session or account.
    setParent(p => ({ ...p, passcodeCreated: false }));
  };

  const savePasscodeToDb = async (pin: string) => {
    const { data: { session } } = await supabase.auth.getSession();
    if (__DEV__) {
      console.log('[Passcode] savePasscodeToDb:', {
        userId:        userId ? userId.slice(0, 8) + '…' : null,
        sessionExists: !!session,
        sessionUid:    session?.user?.id ? session.user.id.slice(0, 8) + '…' : null,
        passcodeCreated: parent.passcodeCreated,
      });
    }
    if (!userId) {
      if (__DEV__) console.log('[Passcode] savePasscodeToDb: userId null — cannot write to DB');
      throw new Error('no_user_id');
    }
    // Session absent means the request will be sent with the ANON KEY, which has no
    // EXECUTE grant on set_parent_passcode — fail early with a clear error rather than
    // letting PostgREST return a confusing 42501 permission-denied response.
    if (!session) {
      if (__DEV__) console.log('[Passcode] savePasscodeToDb: no Supabase session — cannot write to DB');
      throw new Error('no_session');
    }
    await db.setParentPasscode(userId, pin);
  };

  const topUpSafetyPool = async (amount: number) => {
    if (!userId) return;
    const newLimit = await db.topUpSafetyPool(userId, amount);
    setParent(p => ({ ...p, safetyPoolLimit: newLimit }));
  };

  const saveAllowanceToDb = async (amount: number, frequency: string, nextPayment: string | null, active: boolean) => {
    setParent(p => ({
      ...p,
      weeklyAllowance:     amount,
      allowanceFrequency:  frequency,
      allowanceNextPayment: nextPayment ?? '',
      allowanceActive:     active,
    }));
    if (userId) await db.updateAllowance(userId, amount, frequency, nextPayment, active);
  };

  const setMarketingNotifications = async (value: boolean) => {
    setParent(p => ({ ...p, marketingNotifications: value }));
    if (userId) await db.updateMarketingPreference(userId, value);
  };

  // Refresh parent financial data whenever userId is available (on login + every 30 s).
  useEffect(() => {
    if (!userId) return;
    const refresh = () => {
      db.getParentStats(userId).then(stats => {
        if (!stats) return;
        setParent(p => ({
          ...p,
          safetyPoolLimit:     stats.safety_pool_limit,
          safetyPoolUsed:      stats.safety_pool_used,
          weeklyAllowance:     stats.weekly_allowance,
          allowanceFrequency:  stats.allowance_frequency ?? 'weekly',
          allowanceNextPayment: stats.allowance_next_payment ?? '',
          allowanceActive:     stats.allowance_active ?? false,
        }));
      }).catch(() => {});
    };
    refresh();
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, [userId]);

  // Poll every 5 seconds while a child is logged in — picks up new friend requests, circle changes, and resolved sent requests
  useEffect(() => {
    if (!childId) return;
    setActivityFetching(true); // show loading until first DB response
    let firstFetchDone = false;
    const seenExpiredIds = new Set<string>();
    // Turns true after the first async response, so pre-existing expired
    // requests are silently seeded without generating a feed item.
    let expiredFirstDone = false;

    const deadlineDaysToLabel = (days: number) => {
      if (days === 1) return '1d';
      if (days === 3) return '3d';
      if (days === 7) return '1w';
      if (days === 14) return '2w';
      return `${days}d`;
    };
    const formatCreatedAt = (iso: string) => {
      const hours = (Date.now() - new Date(iso).getTime()) / 3600000;
      if (hours < 1) return 'Just now';
      if (hours < 24) return `${Math.floor(hours)}h ago`;
      return `${Math.floor(hours / 24)}d ago`;
    };
    const expiresInHours = (iso: string) =>
      Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 3600000));

    const SESSION_ERROR_CODES = ['invalid_child_session', 'child_session_expired', 'child_session_revoked'];

    const poll = async () => {
      const token = childSessionTokenRef.current;
      const devId = childDeviceIdRef.current;
      if (!token || !devId) return; // Session not yet loaded; skip this tick

      // Route session errors (expired/revoked/invalid) to handleSessionError exactly once
      // per poll cycle. Non-session errors are silently dropped.
      let sessionErrorFired = false;
      const onPollError = (e: unknown) => {
        if (sessionErrorFired) return;
        const msg = String((e as any)?.message ?? '');
        if (SESSION_ERROR_CODES.some(code => msg.includes(code))) {
          sessionErrorFired = true;
          handleSessionErrorRef.current(msg);
        }
      };

      // Each call is independent — one failing cannot block the others

      // 0. Activity feed — merged on every cycle so:
      //    a) DB-written items from counterparty RPCs appear without re-login.
      //    b) Optimistic items added this tick (before this fetch resolved) are not lost.
      //    Sorted by created_at DESC so newest is always first regardless of RPC order.
      if (__DEV__) console.log('[Activity] fetchStart — childId:', childId.slice(0, 8));
      db.getActivityFeed(childId, token, devId).then(items => {
        if (__DEV__) console.log('[Activity] fetchSuccess count:', items.length);
        if (!firstFetchDone) { firstFetchDone = true; setActivityFetching(false); }

        const dbIds = new Set(items.map(i => i.id));

        // Track every ID that has ever appeared in a DB response.
        // If an item was previously in this set but is now absent, it was
        // deleted from DB (e.g. cancelled request) and must leave state too.
        items.forEach(i => persistedActivityIdsRef.current.add(i.id));

        const dbMapped: ActivityItem[] = items.map(i => ({
          id: i.id,
          emoji: i.emoji,
          text: i.text,
          time: formatCreatedAt(i.created_at),
          type: i.type as ActivityItem['type'],
          createdAt: i.created_at,
        }));

        setActivityFeed(prev => {
          const optimistic = prev.filter(a => {
            if (dbIds.has(a.id)) return false; // already in dbMapped

            // Item was previously confirmed in DB but is now gone → deleted, remove it.
            if (persistedActivityIdsRef.current.has(a.id)) return false;

            // For in-memory-only request activities (moneyreq_* or a_req_*): remove
            // if the associated request is no longer active AND the feed has no
            // completion events (funded/repaid) for it — meaning it was cancelled.
            if (a.type === 'request' && activeRequestIdsRef.current !== null) {
              const reqId = a.id.startsWith('moneyreq_') ? a.id.slice(9)
                          : a.id.startsWith('a_req_')    ? a.id.slice(6)
                          : null;
              if (reqId && !activeRequestIdsRef.current.has(reqId)) {
                // Request is gone from active list.  Check for completion events in
                // this child's feed so we don't remove history for funded/repaid loans.
                const hasCompletion =
                  [...prev, ...dbMapped].some(x =>
                    x.id === 'funded_' + reqId || x.id === 'fund_'   + reqId ||
                    x.id === 'repay_'  + reqId || x.id === 'recv_'   + reqId
                  );
                if (!hasCompletion) return false; // cancelled or expired, remove it
              }
            }

            return true; // genuine not-yet-persisted optimistic item, keep it
          });
          const seenIds = new Set<string>();
          const merged = [...optimistic, ...dbMapped]
            .sort((a, b) => {
              const ta = a.createdAt ? new Date(a.createdAt).getTime() : Date.now();
              const tb = b.createdAt ? new Date(b.createdAt).getTime() : Date.now();
              return tb - ta;
            })
            .filter(a => {
              if (seenIds.has(a.id)) return false;
              seenIds.add(a.id);
              return true;
            });
          // Persist merged feed so it survives app close/reopen and logout/login
          cache.saveActivityFeed(childId, merged).catch(() => {});
          return merged;
        });
      }).catch(e => {
        if (__DEV__) console.warn('[Activity] fetchError —', String((e as any)?.message ?? e), '| code:', (e as any)?.code ?? 'n/a');
        if (!firstFetchDone) { firstFetchDone = true; setActivityFetching(false); }
        onPollError(e);
      });

      // 0a. Transaction history from DB (live for both parties)
      db.getChildTransactions(childId, token, devId).then(txs => {
        setTransactions(txs.map(t => ({
          id: t.id,
          type: t.type as Transaction['type'],
          amount: t.amount,
          description: t.description,
          date: formatCreatedAt(t.created_at),
          counterparty: t.counterparty ?? undefined,
          status: 'completed' as const,
        })));
      }).catch(onPollError);

      // 0b. Child's own financials — balance, borrowed, loaned_out, trust score, frozen state
      db.getChildStats(childId, token, devId).then(stats => {
        if (!stats) return;
        setChild(c => ({
          ...c,
          balance:         stats.wallet_balance,
          loanedOut:       stats.loaned_out,
          borrowed:        stats.borrowed,
          trustScore:      stats.trust_score,
          points:          stats.points,
          streak:          stats.streak,
          repaid:          stats.repaid,
          missed:          stats.missed,
          totalBorrowed:   stats.total_borrowed,
          totalLent:       stats.total_lent,
          timesBorrowed:   stats.times_borrowed,
          timesLent:       stats.times_lent,
          profileImageUrl: stats.profile_image_url ?? c.profileImageUrl,
        }));
        setFrozenAccount(stats.account_frozen ?? false);
        setParentDebt(stats.parent_debt ?? 0);
      }).catch(onPollError);

      // 1. Circle members (most critical — must always succeed)
      db.getCircle(childId, token, devId).then(members => {
        setCircle(members.map(m => ({
          id: m.id, displayName: m.display_name,
          username: m.username, avatarEmoji: m.avatar_emoji, trustScore: m.trust_score,
          profileImageUrl: m.avatar_url ?? undefined,
        })));
      }).catch(onPollError);

      // 2. Incoming friend requests
      // "X wants to join your circle" activity items are written server-side
      // by send_circle_request (M067) — no client-side synthesis needed.
      db.getPendingRequests(childId, token, devId).then(requests => {
        const mapped = requests.map(r => ({
          requestId: r.request_id, id: r.id, displayName: r.display_name,
          username: r.username, avatarEmoji: r.avatar_emoji,
          trustScore: r.trust_score, createdAt: r.created_at,
          profileImageUrl: r.avatar_url ?? undefined,
        }));
        setPendingRequests(mapped);
      }).catch(onPollError);

      // 4. Active money requests from self + circle
      db.getActiveRequests(childId, token, devId).then(moneyReqs => {
        const now = Date.now();
        const isExpired = (r: typeof moneyReqs[0]) =>
          r.status === 'pending' && new Date(r.expires_at).getTime() <= now;

        // "funded your request" and "X requested £Y" activity items are written
        // server-side by fund_money_request / create_money_request (M067) — only
        // client-side-computed expiry (no DB row transition to hook) stays here.
        moneyReqs.forEach(r => {
          // Detect own pending requests that just expired → notify requester
          if (r.is_own && isExpired(r) && !seenExpiredIds.has(r.id)) {
            seenExpiredIds.add(r.id);
            if (expiredFirstDone) {
              addActivity({
                id: `expired_${r.id}`,
                emoji: '⏰',
                text: `Your £${fmtAmt(Number(r.amount))} request expired unfunded`,
                time: 'Just now',
                type: 'missed' as const,
              });
            }
          }
        });
        expiredFirstDone = true;

        // Keep activeRequestIdsRef current so the activity-feed merge can
        // detect request activities that belong to cancelled/expired requests.
        activeRequestIdsRef.current = new Set(moneyReqs.map(r => r.id));

        // Exclude expired pending requests — they drop off everyone's circle page
        // via this same poll; funded requests are kept until repaid.
        setActiveRequests(() =>
          moneyReqs
            .filter(r => !isExpired(r))
            .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
            .map(r => ({
              id: r.id,
              fromId: r.from_id,
              fromName: r.from_name,
              fromEmoji: r.from_emoji,
              fromTrust: r.from_trust,
              amount: r.amount,
              reason: r.reason,
              reasonEmoji: r.reason_emoji,
              deadline: deadlineDaysToLabel(r.deadline_days),
              repayByDate: r.repay_by_date,
              expiresIn: expiresInHours(r.expires_at),
              createdAt: formatCreatedAt(r.created_at),
              isOwn: r.is_own,
              isFunded: r.status === 'funded',
              fundedById: r.funded_by ?? undefined,
              fundedByName: r.funded_by_name ?? undefined,
              fundedByEmoji: r.funded_by_emoji ?? undefined,
            }))
        );
      }).catch(onPollError);
    };
    poll(); // immediate first fetch
    const id = setInterval(poll, 5000);
    return () => {
      clearInterval(id);
      // Reset per-session refs so the next child login starts with a clean slate.
      persistedActivityIdsRef.current = new Set();
      activeRequestIdsRef.current = null;
      setActivityFetching(false);
    };
  }, [childId]);

  const clearSessionState = (storedChildId: string | null, sessionToken: string | null) => {
    if (sessionToken) db.revokeChildSession(sessionToken).catch(() => {});
    if (storedChildId) clearChildSession(storedChildId).catch(() => {});
    setChildSessionToken(null);
  };

  const resetSession = async () => {
    await supabase.auth.signOut().catch(() => {});
    await deregisterCurrentPushToken().catch(() => {});
    clearSessionState(childIdRef.current, childSessionToken);

    setChild({
      displayName: '', username: '', avatarEmoji: '😊', trustScore: 50,
      balance: 0, loanedOut: 0, borrowed: 0, streak: 0, repaid: 0, missed: 0,
      totalBorrowed: 0, totalLent: 0, timesBorrowed: 0, timesLent: 0,
      points: 0, age: 16, mobile: '', email: '',
      biometricEnabled: false, profileImageUrl: undefined,
    });
    setChildId(null);
    setParent({
      firstName: '', lastName: '', displayName: '', email: '', mobile: '',
      address: '', safetyPoolLimit: 0, safetyPoolUsed: 0, weeklyAllowance: 10,
      allowanceFrequency: 'weekly', allowanceNextPayment: '', allowanceActive: false,
      passcodeCreated: false, marketingNotifications: false,
    });
    setUserId(null);
    setActivityFeed([]);
    setActivityFetching(false);
    setTransactions([]);
    setActiveRequests([]);
    setCircle([]);
    setPendingRequests([]);
    setFrozenAccount(false);
    setParentDebt(0);
    setPaymentMethods([]);
    setBiometricEnabled(false);
    cache.clear();
  };

  const autoLogout = async () => {
    await supabase.auth.signOut().catch(() => {});
    await deregisterCurrentPushToken().catch(() => {});
    clearSessionState(childIdRef.current, childSessionTokenRef.current);
    setChildId(null);          // stops the polling loop immediately
    setIsChildLoggedIn(false);
    cache.clearBackgroundedAt();
    if (navigationRef.isReady()) {
      navigationRef.reset({ index: 0, routes: [{ name: 'WhoIsLoggingIn' as never }] });
    }
  };

  const handleSessionError = async (code: string) => {
    const priorChildId = childIdRef.current;
    clearSessionState(priorChildId, childSessionTokenRef.current);
    setIsChildLoggedIn(false);

    // If Face ID is still set up for this child on this device, keep them as the
    // pre-selected/default tile on "Who's logging in?" so tapping it goes straight
    // to Face ID — a valid biometric login issues a fresh session token, so an
    // expired/revoked session should NOT force a full username/password re-entry.
    // IMPORTANT: never navigate straight into BiometricLogin (or ChildLogin) here.
    // A session error can fire during hydrate, before the user has touched
    // anything, and jumping past "Who's logging in?" would auto-launch the native
    // Face ID prompt (or the password form) with no user action — exactly the bug
    // reported. Always land on WhoIsLoggingIn and let the user tap a tile.
    let biometricChildId: string | null = null;
    try {
      const lastChild = priorChildId ?? (await getLastChildForBiometric());
      if (lastChild) {
        const [available, hasBio] = await Promise.all([
          isBiometricAvailable(),
          hasBiometricForChild(lastChild),
        ]);
        if (available && hasBio) biometricChildId = lastChild;
      }
    } catch {
      // fall through to password login
    }

    if (biometricChildId) {
      setChildId(biometricChildId); // WhoIsLoggingInScreen's child tile reads this
    } else {
      setChildId(null); // stops the polling loop immediately
      setSessionExpiredNotice(true); // shown once ChildLogin is reached via a tap
    }

    if (navigationRef.isReady()) {
      navigationRef.reset({ index: 0, routes: [{ name: 'WhoIsLoggingIn' as never }] });
    }
  };
  // Keep ref current so poll() always calls the latest version without stale closure.
  handleSessionErrorRef.current = handleSessionError;

  return (
    <AppContext.Provider value={{
      paymentMethods, addPaymentMethod, removePaymentMethod, setDefaultPaymentMethod,
      isOnboarded, setIsOnboarded,
      authHydrated, hasStoredAccount,
      isChildLoggedIn, setIsChildLoggedIn,
      child, setChild,
      childId, setChildId,
      sessionExpiredNotice, clearSessionExpiredNotice,
      pendingRequests, setPendingRequests,
      parent, setParent,
      circle, setCircle,
      transactions,
      activeRequests, setActiveRequests,
      activityFeed, activityFetching, addActivity, removeActivity,
      frozenAccount, setFrozenAccount,
      parentDebt, setParentDebt,
      adjustTrustScore,
      repayOnTime, lendMoney, missRepayment, repayParent,
      addTransaction,
      userId, setUserId,
      setOnboardingPassword,
      saveOnboardingToDb,
      savePasscodeToDb,
      topUpSafetyPool,
      saveAllowanceToDb,
      setMarketingNotifications,
      recordWeeklyStreak,
      biometricEnabled,
      setBiometricEnabled,
      repayHighlightId,
      setRepayHighlightId,
      childSessionToken,
      setChildSessionToken,
      childDeviceId,
      handleSessionError,
      resetSession,
      autoLogout,
    }}>
      {children}
    </AppContext.Provider>
  );
};

export const useApp = () => useContext(AppContext);
