import React, { useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Alert,
  ActivityIndicator, TextInput, KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { CommonActions } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useStripe } from '@stripe/stripe-react-native';
import { RootStackParamList } from '../../navigation/types';
import { useApp } from '../../context/AppContext';
import { supabase } from '../../lib/supabase';

const GREEN = '#C8E8CB';
const PRESETS = [25, 50, 100, 200];

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'SafetyPool'>;
};

export const SafetyPoolSetupScreen: React.FC<Props> = ({ navigation }) => {
  const { childId, userId, setParent } = useApp();
  const { initPaymentSheet, presentPaymentSheet } = useStripe();

  const [raw, setRaw] = useState('');
  const [saving, setSaving] = useState(false);

  const amount = parseFloat(raw) || 0;
  const canContinue = amount >= 5;

  const selectPreset = (p: number) => setRaw(String(p));

  // Same pattern as ParentHomeScreen's safety-pool top-up: create a PaymentIntent,
  // present the Stripe PaymentSheet, then the stripe-webhook → stripe_complete_topup()
  // credits parents.safety_pool_limit server-side once payment_intent.succeeded fires.
  const handleContinue = async () => {
    if (!canContinue) {
      Alert.alert('Minimum £5', 'Please enter at least £5 for your Safety Pool.');
      return;
    }
    if (!childId) {
      Alert.alert('Error', 'No child account linked. Please contact support.');
      return;
    }

    setSaving(true);
    try {
      const amountPence = Math.round(amount * 100);
      const { data, error: fnError } = await supabase.functions.invoke(
        'create-stripe-payment-intent',
        { body: { child_id: childId, amount: amountPence, purpose: 'safety_pool' } },
      );
      if (fnError || !data?.client_secret) {
        throw new Error(fnError?.message ?? 'Could not start payment.');
      }

      const { error: initError } = await initPaymentSheet({
        merchantDisplayName: 'Breesh',
        paymentIntentClientSecret: data.client_secret,
        returnURL: 'breesh://stripe-return',
      });
      if (initError) throw new Error(initError.message);

      const { error: presentError } = await presentPaymentSheet();
      if (presentError) {
        if (presentError.code !== 'Canceled') {
          Alert.alert('Payment failed', 'Your payment could not be completed. Please try again.');
        }
        return;
      }

      // Payment authorised — give the webhook a moment to credit the pool, then
      // pull the fresh balance into context before handing off to the dashboard.
      await new Promise<void>(resolve => setTimeout(resolve, 4000));
      const { data: row } = await supabase
        .from('parents')
        .select('safety_pool_limit')
        .eq('id', userId)
        .single();
      setParent(p => ({
        ...p,
        safetyPoolLimit: row?.safety_pool_limit ?? p.safetyPoolLimit,
        safetyPoolUsed: 0,
      }));

      navigation.dispatch(CommonActions.reset({ index: 0, routes: [{ name: 'ParentTabs' }] }));
    } catch (e: any) {
      Alert.alert('Payment error', e.message ?? 'Could not process your payment. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.header}>
          <TouchableOpacity
            onPress={() => navigation.goBack()}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          >
            <Ionicons name="chevron-back" size={28} color="#1A1A3E" />
          </TouchableOpacity>
        </View>
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Icon */}
          <LinearGradient
            colors={['#C8E8CB', '#93C999'] as const}
            style={styles.iconWrap}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
          >
            <Ionicons name="shield-checkmark" size={36} color="#1F2937" />
          </LinearGradient>

          <Text style={styles.title}>Set up your Safety Pool</Text>
          <Text style={styles.sub}>
            Your Safety Pool protects your child if they can't repay a loan on time.
            {'\n\n'}
            If a repayment is missed, the amount is automatically covered from your pool — keeping their account active and their trust score intact.
          </Text>

          {/* How it works */}
          <View style={styles.infoCard}>
            {[
              { icon: 'trending-up-outline', text: 'Child borrows from their circle' },
              { icon: 'time-outline',        text: 'If they miss a repayment deadline' },
              { icon: 'shield-checkmark-outline', text: 'Your pool covers the shortfall' },
              { icon: 'lock-open-outline',   text: 'Account unfreezes once they repay you' },
            ].map((row, i) => (
              <View key={i} style={styles.infoRow}>
                <View style={styles.infoIcon}>
                  <Ionicons name={row.icon as any} size={18} color={GREEN} />
                </View>
                <Text style={styles.infoText}>{row.text}</Text>
              </View>
            ))}
          </View>

          {/* Amount input */}
          <Text style={styles.inputLabel}>How much do you want to fund?</Text>
          <View style={styles.amtRow}>
            <Text style={styles.amtPrefix}>£</Text>
            <TextInput
              style={styles.amtInput}
              value={raw}
              onChangeText={t => setRaw(t.replace(/[^0-9.]/g, ''))}
              keyboardType="decimal-pad"
              placeholder="0"
              placeholderTextColor="#C7C7CC"
              maxLength={6}
            />
          </View>

          {/* Preset chips */}
          <View style={styles.presetRow}>
            {PRESETS.map(p => (
              <TouchableOpacity
                key={p}
                style={[styles.preset, amount === p && styles.presetActive]}
                onPress={() => selectPreset(p)}
                activeOpacity={0.7}
              >
                <Text style={[styles.presetText, amount === p && styles.presetTextActive]}>£{p}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {amount > 0 && (
            <View style={styles.summaryCard}>
              <Ionicons name="checkmark-circle" size={18} color="#16A34A" />
              <Text style={styles.summaryText}>
                £{amount.toFixed(2)} Safety Pool · your child can borrow up to £{Math.min(100, amount).toFixed(2)}
              </Text>
            </View>
          )}
        </ScrollView>

        <View style={styles.footer}>
          <TouchableOpacity
            style={[styles.btn, (!canContinue || saving) && styles.btnDisabled]}
            onPress={handleContinue}
            disabled={!canContinue || saving}
            activeOpacity={0.85}
          >
            {saving
              ? <ActivityIndicator color="#1F2937" />
              : <Text style={styles.btnText}>Continue to Dashboard</Text>
            }
          </TouchableOpacity>
          <Text style={styles.footerNote}>You can add more to your pool at any time from your dashboard.</Text>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: '#fff' },
  header: { paddingHorizontal: 16, paddingVertical: 12 },
  scroll: { padding: 24, paddingTop: 8, gap: 20 },

  iconWrap: {
    width: 72, height: 72, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
    alignSelf: 'center', marginBottom: 4,
  },
  title: { fontSize: 28, fontWeight: '800', color: '#1A1A3E', textAlign: 'center' },
  sub:   { fontSize: 15, color: '#3C3C43', lineHeight: 22, textAlign: 'center' },

  infoCard: {
    backgroundColor: '#F1FAF2', borderRadius: 16,
    padding: 16, gap: 12,
  },
  infoRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  infoIcon: {
    width: 34, height: 34, borderRadius: 10,
    backgroundColor: '#E8F5E9', alignItems: 'center', justifyContent: 'center',
  },
  infoText: { fontSize: 14, fontWeight: '600', color: '#1A1A3E', flex: 1 },

  inputLabel: { fontSize: 15, fontWeight: '700', color: '#1A1A3E' },
  amtRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#F2F2F7', borderRadius: 16,
    paddingHorizontal: 20, paddingVertical: 4,
  },
  amtPrefix: { fontSize: 36, fontWeight: '800', color: '#1A1A3E', marginRight: 4 },
  amtInput:  { flex: 1, fontSize: 48, fontWeight: '900', color: '#1A1A3E', paddingVertical: 12 },

  presetRow: { flexDirection: 'row', gap: 10 },
  preset: {
    flex: 1, paddingVertical: 12, borderRadius: 14,
    backgroundColor: '#F2F2F7', alignItems: 'center',
    borderWidth: 1.5, borderColor: 'transparent',
  },
  presetActive:     { backgroundColor: '#E8F5E9', borderColor: GREEN },
  presetText:       { fontSize: 15, fontWeight: '700', color: '#3C3C43' },
  presetTextActive: { color: '#2E7D32' },

  summaryCard: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: '#F0FDF4', borderRadius: 12, padding: 14,
    borderWidth: 1, borderColor: '#BBF7D0',
  },
  summaryText: { flex: 1, fontSize: 14, fontWeight: '600', color: '#166534' },

  footer: { paddingHorizontal: 24, paddingBottom: 16, paddingTop: 8, gap: 10 },
  btn: {
    backgroundColor: GREEN, borderRadius: 50,
    paddingVertical: 18, alignItems: 'center',
  },
  btnDisabled: { opacity: 0.45 },
  btnText:     { fontSize: 17, fontWeight: '700', color: '#1F2937' },
  footerNote:  { fontSize: 12, color: '#8E8E93', textAlign: 'center' },
});
