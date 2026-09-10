import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert, Modal, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useStripe } from '@stripe/stripe-react-native';
import { colors, getTierInfo } from '../../theme/colors';
import { TrustScoreRing } from '../../components/TrustScoreRing';
import { MoneySheet } from '../../components/MoneySheet';
import { useApp } from '../../context/AppContext';
import { supabase } from '../../lib/supabase';
import { fmtAmt } from '../../lib/utils';


function describeAmountError(msg: string): string {
  if (msg.includes('amount_below_minimum')) return 'Amount must be at least £0.50.';
  if (msg.includes('amount_precision_invalid')) return 'Please enter a whole number or up to 2 decimal places (e.g. £5.50).';
  if (msg.includes('invalid_amount')) return 'Please enter a valid amount.';
  return msg;
}

export const ParentHomeScreen: React.FC = () => {
  const { child, parent, setChild, addActivity, frozenAccount, parentDebt, repayParent, childId, activityFeed } = useApp();
  const { initPaymentSheet, presentPaymentSheet } = useStripe();

  const [topUpVisible, setTopUpVisible] = useState(false);
const [sendMoneyVisible, setSendMoneyVisible] = useState(false);

  // Stripe state (shared by both send-money and safety-pool flows)
  const [stripeLoading, setStripeLoading] = useState(false);
  const [stripeProcessing, setStripeProcessing] = useState(false);
  const [stripeProcessingLabel, setStripeProcessingLabel] = useState('');
  const tier = getTierInfo(child.trustScore);
  const poolPercent = (parent.safetyPoolUsed / parent.safetyPoolLimit) * 100;

  const [showAllActivity, setShowAllActivity] = useState(false);

  // Derive the child's first name for parent-perspective activity wording.
  const childFirstName = child.displayName.split(' ')[0] || 'Your child';

  // Transform child-perspective activity text into parent-perspective at render time.
  // Does NOT mutate the shared activityFeed state — child dashboard is unaffected.
  const toParentText = (text: string): string => {
    let t = text;
    // Handle sentence-start cases first (capitalised)
    if (t.startsWith('You ')) t = childFirstName + ' ' + t.slice(4);
    else if (t.startsWith('Your ')) t = `${childFirstName}'s ` + t.slice(5);
    // Handle contractions before their component words
    t = t.replace(/\byou're\b/gi, `${childFirstName} is`);
    t = t.replace(/\byou've\b/gi, `${childFirstName} has`);
    // Replace remaining "your" and "you" (word-boundary, case-insensitive)
    t = t.replace(/\byour\b/gi, `${childFirstName}'s`);
    t = t.replace(/\byou\b/gi, childFirstName);
    return t;
  };

  // Filter and transform the feed for the parent view:
  //   • Hide 'topup' items (parent-to-child sends, allowances) — parent already knows
  //   • Hide 'spend' items — not meaningful in parent oversight view
  //   • Replace child-perspective "You/Your" wording with the child's first name
  const parentActivityFeed = activityFeed
    .filter(a => a.type !== 'topup' && a.type !== 'spend')
    .map(a => ({ ...a, text: toParentText(a.text) }));

  const parentActivity = showAllActivity ? parentActivityFeed : parentActivityFeed.slice(0, 3);

  // ── Stripe payments ──────────────────────────────────────────────────────
  // Shared handler for both child wallet top-up and safety pool top-up.
  // NEVER calls parentSendToChild or directly updates any balance.
  // All balance updates happen via the Stripe webhook → stripe_complete_topup().
  const initiateStripeTopUp = async (
    amountGbp: number,
    purpose: 'child_wallet' | 'safety_pool' = 'child_wallet',
  ) => {
    if (!childId) {
      Alert.alert('Error', 'No child account linked. Please contact support.');
      return;
    }

    setStripeLoading(true);
    try {
      // 1. Create PaymentIntent on the server — returns client_secret only
      const amountPence = Math.round(amountGbp * 100);
      console.log('[Stripe] invoking create-stripe-payment-intent', { amountPence, childId, purpose });
      const { data, error: fnError } = await supabase.functions.invoke(
        'create-stripe-payment-intent',
        { body: { child_id: childId, amount: amountPence, purpose } },
      );

      if (fnError || !data?.client_secret) {
        console.log('[Stripe] edge function error', fnError?.message, JSON.stringify(data));
        Alert.alert('Payment error', `Could not start payment: ${fnError?.message ?? 'no client_secret'}`);
        if (purpose === 'safety_pool') setTopUpVisible(true);
        else setSendMoneyVisible(true);
        return;
      }
      console.log('[Stripe] got client_secret, initialising PaymentSheet');

      // 2. Prepare Stripe PaymentSheet
      const { error: initError } = await initPaymentSheet({
        merchantDisplayName: 'Breesh',
        paymentIntentClientSecret: data.client_secret,
        returnURL: 'breesh://stripe-return',
      });

      if (initError) {
        console.log('[Stripe] initPaymentSheet error', initError.code, initError.message);
        Alert.alert('Payment error', `Could not prepare payment: ${initError.message}`);
        if (purpose === 'safety_pool') setTopUpVisible(true);
        else setSendMoneyVisible(true);
        return;
      }
      console.log('[Stripe] PaymentSheet ready, presenting');

      // 3. Present the native Stripe PaymentSheet.
      // Dismiss the loading modal first and wait for its fade animation to
      // complete — presenting the PaymentSheet while a modal is animating out
      // causes it to flash and crash on iOS.
      setStripeLoading(false);
      await new Promise<void>(resolve => setTimeout(resolve, 350));
      const { error: presentError } = await presentPaymentSheet();
      console.log('[Stripe] presentPaymentSheet returned', presentError?.code, presentError?.message);

      if (presentError?.code === 'Canceled') {
        if (purpose === 'safety_pool') setTopUpVisible(true);
        else setSendMoneyVisible(true);
        return;
      }

      if (presentError) {
        Alert.alert('Payment failed', 'Your payment could not be completed. Please try again.');
        if (purpose === 'safety_pool') setTopUpVisible(true);
        else setSendMoneyVisible(true);
        return;
      }

      // 4. PaymentSheet authorised — show processing card and re-fetch after
      // a short delay to pick up the webhook update.
      setStripeProcessingLabel(
        purpose === 'safety_pool'
          ? 'Your Safety Pool will update in a moment.'
          : `${child.displayName}'s balance will update in a moment once the payment is confirmed.`,
      );
      setStripeProcessing(true);
      setTimeout(async () => {
        try {
          if (purpose === 'safety_pool') {
            const { data: row } = await supabase
              .from('parents')
              .select('safety_pool_limit')
              .eq('id', parent.id ?? childId)
              .single();
            if (row?.safety_pool_limit !== undefined) {
              // AppContext doesn't expose a setParent for this field directly;
              // the updated value will appear on next navigation/refresh.
            }
          } else {
            const { data: row } = await supabase
              .from('children')
              .select('wallet_balance')
              .eq('id', childId)
              .single();
            if (row?.wallet_balance !== undefined) {
              setChild(c => ({ ...c, balance: row.wallet_balance }));
            }
          }
        } catch { /* balance will refresh on next login or manual pull */ }
        setStripeProcessing(false);
      }, 4000);

    } catch {
      Alert.alert('Payment error', 'An unexpected error occurred. Please try again.');
      setSendMoneyVisible(true);
    } finally {
      setStripeLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <View>
          <Text style={styles.headerGreeting}>Hello, {parent.displayName}</Text>
          <Text style={styles.headerSub}>Parent dashboard</Text>
        </View>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>
        {/* Child overview */}
        <View style={styles.childCard}>
          <View style={styles.childHeader}>
            <View style={styles.childAvatar}><Text style={{ fontSize: 28 }}>{child.avatarEmoji}</Text></View>
            <View>
              <Text style={styles.childName}>{child.displayName.split(' ')[0]}</Text>
              <Text style={styles.childUsername}>@{child.username}</Text>
            </View>
            <View style={[styles.tierPill, { backgroundColor: `${tier.color}20` }]}>
              <Text style={[styles.tierText, { color: tier.color }]}>{tier.emoji} {tier.tier}</Text>
            </View>
          </View>
          <View style={styles.childStats}>
            <TrustScoreRing score={child.trustScore} size={100} />
            <View style={styles.childStatsRight}>
              <View style={styles.childStatRow}>
                <Text style={styles.childStatLabel}>Balance</Text>
                <Text style={styles.childStatValue}>£{fmtAmt(child.balance)}</Text>
              </View>
              <View style={styles.childStatRow}>
                <Text style={styles.childStatLabel}>Lent to friends</Text>
                <Text style={[styles.childStatValue, { color: colors.warning }]}>£{fmtAmt(child.loanedOut)}</Text>
              </View>
              <View style={styles.childStatRow}>
                <Text style={styles.childStatLabel}>Owes to circle</Text>
                <Text style={[styles.childStatValue, { color: child.borrowed > 0 ? colors.error : colors.success }]}>£{fmtAmt(child.borrowed)}</Text>
              </View>
              <View style={styles.childStatRow}>
                <Text style={styles.childStatLabel}>Week Streak</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  <Ionicons name="flame-outline" size={14} color="#F97316" />
                  <Text style={styles.childStatValue}>{child.streak}</Text>
                </View>
              </View>
              <View style={styles.childStatRow}>
                <Text style={styles.childStatLabel}>Repaid</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  <Text style={[styles.childStatValue, { color: colors.success }]}>{child.repaid}</Text>
                  <Ionicons name="checkmark-circle" size={14} color={colors.success} />
                </View>
              </View>
            </View>
          </View>
          {frozenAccount && (
            <View style={styles.frozenBanner}>
              <View style={styles.frozenRow}>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Ionicons name="lock-closed" size={14} color={colors.error} />
                    <Text style={styles.frozenTitle}>Account frozen</Text>
                  </View>
                  <Text style={styles.frozenText}>
                    {child.displayName} missed a loan repayment — £{fmtAmt(parentDebt)} was auto-paid from your safety pool. Once they repay you, confirm below to unfreeze their account.
                  </Text>
                </View>
              </View>
              <TouchableOpacity
                style={styles.confirmRepayBtn}
                activeOpacity={0.85}
                onPress={() => {
                  repayParent();
                  addActivity({
                    id: `a_repayparent_${Date.now()}`,
                    emoji: '✅',
                    text: `Repayment confirmed · ${childFirstName}'s account unfrozen`,
                    time: 'Just now',
                    type: 'repaid',
                  });
                }}
              >
                <Ionicons name="checkmark-circle-outline" size={18} color="#fff" />
                <Text style={styles.confirmRepayText}>Confirm repayment of £{fmtAmt(parentDebt)}</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>

        {/* Safety Pool */}
        <LinearGradient colors={['#C8E8CB', '#93C999'] as const} style={styles.poolCard} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}>
          <View style={styles.poolHeader}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Ionicons name="shield-checkmark-outline" size={16} color="rgba(255,255,255,0.9)" />
            <Text style={styles.poolTitle}>Safety Pool</Text>
          </View>
            <TouchableOpacity style={styles.topUpChip} onPress={() => setTopUpVisible(true)}>
              <Text style={styles.topUpChipText}>Top up</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.poolAmount}>£{parent.safetyPoolLimit - parent.safetyPoolUsed} <Text style={styles.poolSub}>available</Text></Text>
          <View style={styles.poolBar}>
            <View style={[styles.poolFill, { width: `${Math.min(poolPercent, 100)}%` }]} />
          </View>
          <View style={styles.poolFooter}>
            <Text style={styles.poolFooterText}>£{parent.safetyPoolUsed} used of £{parent.safetyPoolLimit}</Text>
            {poolPercent >= 80 && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Ionicons name="alert-circle" size={14} color="#FDE68A" />
                <Text style={styles.poolWarning}>80%+ used</Text>
              </View>
            )}
          </View>
        </LinearGradient>

        {/* Quick actions */}
        <View style={styles.actions}>
          <TouchableOpacity style={styles.actionBtn} onPress={() => Alert.alert('Coming Soon', 'Automatic allowances are coming in a future update.')}>
            <View style={styles.actionIcon}><Ionicons name="wallet-outline" size={24} color="#2E7D32" /></View>
            <Text style={styles.actionLabel}>Set Allowance</Text>
            <Text style={styles.actionValue}>Coming soon</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.actionBtn} onPress={() => setSendMoneyVisible(true)}>
            <View style={styles.actionIcon}><Ionicons name="send-outline" size={24} color="#2E7D32" /></View>
            <Text style={styles.actionLabel}>Send Money</Text>
            <Text style={styles.actionValue}>Now</Text>
          </TouchableOpacity>
        </View>

        {/* Activity */}
        <View style={styles.sectionHeader}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Ionicons name="flash-outline" size={16} color={colors.gold} />
            <Text style={styles.sectionTitle}>Recent Activity</Text>
          </View>
          {parentActivityFeed.length > 3 && (
            <TouchableOpacity onPress={() => setShowAllActivity(v => !v)}>
              <Text style={styles.viewAllText}>{showAllActivity ? 'Show less' : 'View all'}</Text>
            </TouchableOpacity>
          )}
        </View>
        <View style={styles.activityList}>
          {parentActivity.length === 0 ? (
            <View style={styles.activityRow}>
              <Text style={[styles.activityText, { color: colors.textLight }]}>No recent activity yet.</Text>
            </View>
          ) : parentActivity.map(a => (
            <View key={a.id} style={styles.activityRow}>
              <View style={styles.activityIcon}><Text style={{ fontSize: 18 }}>{a.emoji}</Text></View>
              <View style={{ flex: 1 }}>
                <Text style={styles.activityText}>{a.text}</Text>
                <Text style={styles.activityTime}>{a.time}</Text>
              </View>
            </View>
          ))}
        </View>
        <View style={{ height: 24 }} />
      </ScrollView>

      {/* Top up safety pool — real Stripe card payment */}
      <MoneySheet
        visible={topUpVisible}
        title="Top up Safety Pool"
        subtitle={`Current pool: £${parent.safetyPoolLimit} · £${parent.safetyPoolUsed} used`}
        confirmLabel="Pay by card"
        isPayment
        onClose={() => setTopUpVisible(false)}
        onConfirm={amt => {
          setTopUpVisible(false);
          initiateStripeTopUp(amt, 'safety_pool');
        }}
      />

      {/* Send money to child */}
      <MoneySheet
        visible={sendMoneyVisible}
        title={`Send to ${child.displayName}`}
        subtitle="Added directly to their wallet balance"
        confirmLabel="Pay by card"
        isPayment
        onClose={() => setSendMoneyVisible(false)}
        onConfirm={amt => {
          setSendMoneyVisible(false);
          initiateStripeTopUp(amt);
        }}
      />


      {/* Stripe loading overlay — plain View, not a Modal, so it doesn't
          block iOS from presenting the native Stripe PaymentSheet */}
      {stripeLoading && (
        <View style={[styles.stripeOverlay, StyleSheet.absoluteFillObject]}>
          <ActivityIndicator size="large" color="#fff" />
          <Text style={styles.stripeOverlayText}>Preparing payment…</Text>
        </View>
      )}

      {/* Stripe processing modal — shown after PaymentSheet success */}
      <Modal visible={stripeProcessing} transparent animationType="fade" statusBarTranslucent>
        <View style={styles.stripeOverlay}>
          <View style={styles.stripeProcessingCard}>
            <View style={styles.stripeSuccessCircle}>
              <Ionicons name="checkmark" size={32} color="#fff" />
            </View>
            <Text style={styles.stripeProcessingTitle}>Payment submitted</Text>
            <Text style={styles.stripeProcessingBody}>{stripeProcessingLabel}</Text>
            <TouchableOpacity
              style={styles.stripeDoneBtn}
              onPress={() => setStripeProcessing(false)}
              activeOpacity={0.85}
            >
              <Text style={styles.stripeDoneBtnText}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  header: { padding: 20, paddingBottom: 12, backgroundColor: colors.white },
  headerGreeting: { fontSize: 20, fontWeight: '800', color: colors.text },
  headerSub: { fontSize: 13, color: colors.textSecondary, marginTop: 2 },
  scroll: { padding: 16, gap: 16 },
  childCard: { backgroundColor: colors.white, borderRadius: 20, padding: 16 },
  childHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 16 },
  childAvatar: { width: 52, height: 52, borderRadius: 26, backgroundColor: colors.primaryLight, alignItems: 'center', justifyContent: 'center' },
  childName: { fontSize: 17, fontWeight: '800', color: colors.text },
  childUsername: { fontSize: 13, color: colors.textSecondary },
  tierPill: { marginLeft: 'auto', borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4 },
  tierText: { fontSize: 12, fontWeight: '700' },
  childStats: { flexDirection: 'row', alignItems: 'center', gap: 20 },
  childStatsRight: { flex: 1, gap: 10 },
  childStatRow: { flexDirection: 'row', justifyContent: 'space-between' },
  childStatLabel: { fontSize: 13, color: colors.textSecondary },
  childStatValue: { fontSize: 13, fontWeight: '700', color: colors.text },
  frozenBanner: { marginTop: 14, backgroundColor: '#FEF2F2', borderRadius: 12, padding: 14, gap: 12, borderWidth: 1.5, borderColor: '#FECACA' },
  frozenRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  frozenTitle: { fontSize: 14, fontWeight: '800', color: colors.error, marginBottom: 4 },
  frozenText: { fontSize: 13, color: '#991B1B', lineHeight: 18 },
  confirmRepayBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: '#16A34A', borderRadius: 12, paddingVertical: 14 },
  confirmRepayText: { fontSize: 14, fontWeight: '700', color: colors.white, flexShrink: 1 },
  poolCard: { borderRadius: 20, padding: 20 },
  poolHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  poolTitle: { fontSize: 16, fontWeight: '700', color: '#1F2937' },
  topUpChip: { backgroundColor: 'rgba(0,0,0,0.08)', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 6 },
  topUpChipText: { fontSize: 13, fontWeight: '700', color: '#1F2937' },
  poolAmount: { fontSize: 36, fontWeight: '900', color: '#1F2937', marginBottom: 12 },
  poolSub: { fontSize: 16, fontWeight: '500', color: 'rgba(0,0,0,0.55)' },
  poolBar: { height: 8, backgroundColor: 'rgba(0,0,0,0.12)', borderRadius: 4, marginBottom: 8 },
  poolFill: { height: 8, backgroundColor: '#3D7A45', borderRadius: 4 },
  poolFooter: { flexDirection: 'row', justifyContent: 'space-between' },
  poolFooterText: { fontSize: 13, color: 'rgba(0,0,0,0.6)' },
  poolWarning: { fontSize: 13, color: colors.warningLight, fontWeight: '700' },
  actions: { flexDirection: 'row', gap: 12 },
  actionBtn: { flex: 1, backgroundColor: colors.white, borderRadius: 16, padding: 16, alignItems: 'center', gap: 6 },
  actionIcon: { width: 52, height: 52, borderRadius: 16, backgroundColor: colors.primaryLight, alignItems: 'center', justifyContent: 'center' },
  actionLabel: { fontSize: 13, fontWeight: '700', color: colors.text },
  actionValue: { fontSize: 12, color: '#2E7D32', fontWeight: '700' },
  sectionHeader: { paddingHorizontal: 4, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionTitle: { fontSize: 17, fontWeight: '800', color: colors.text },
  viewAllText: { fontSize: 14, fontWeight: '700', color: '#2E7D32' },
  activityList: { backgroundColor: colors.white, borderRadius: 16, overflow: 'hidden' },
  activityRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, padding: 14, borderBottomWidth: 1, borderBottomColor: colors.surface },
  activityIcon: { width: 36, height: 36, borderRadius: 10, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  activityText: { fontSize: 14, fontWeight: '500', color: colors.text, lineHeight: 20 },
  activityTime: { fontSize: 12, color: colors.textLight, marginTop: 2 },

  // Stripe payment overlays
  stripeOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.72)',
    alignItems: 'center', justifyContent: 'center', gap: 16,
  },
  stripeOverlayText: { fontSize: 16, fontWeight: '600', color: '#fff' },
  stripeProcessingCard: {
    backgroundColor: '#fff', borderRadius: 24,
    padding: 28, marginHorizontal: 32,
    alignItems: 'center', gap: 14,
  },
  stripeSuccessCircle: {
    width: 64, height: 64, borderRadius: 32,
    backgroundColor: '#30D158',
    alignItems: 'center', justifyContent: 'center',
  },
  stripeProcessingTitle: { fontSize: 20, fontWeight: '800', color: colors.text, textAlign: 'center' },
  stripeProcessingBody: { fontSize: 14, color: colors.textSecondary, textAlign: 'center', lineHeight: 20 },
  stripeDoneBtn: {
    marginTop: 4, backgroundColor: '#2E7D32',
    borderRadius: 14, paddingVertical: 14, paddingHorizontal: 36,
  },
  stripeDoneBtnText: { fontSize: 16, fontWeight: '700', color: '#fff' },
});
