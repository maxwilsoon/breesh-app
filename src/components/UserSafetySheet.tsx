import React, { useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Modal, Alert,
  TextInput, ScrollView, ActivityIndicator, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { db } from '../lib/database';

export type SafetyTarget = {
  id: string;
  displayName: string;
  username: string;
};

type Props = {
  visible: boolean;
  target: SafetyTarget | null;
  childId: string | null;
  sessionToken: string | null;
  deviceId: string | null;
  onClose: () => void;
  onBlockSuccess: (blockedId: string) => void;
};

const REPORT_REASONS: Array<{ key: string; label: string }> = [
  { key: 'harassment_bullying',    label: 'Harassment or bullying' },
  { key: 'spam',                   label: 'Spam' },
  { key: 'scam_fraud',             label: 'Scam or fraud' },
  { key: 'inappropriate_content',  label: 'Inappropriate behaviour or content' },
  { key: 'threatening_behaviour',  label: 'Threatening behaviour' },
  { key: 'impersonation',          label: 'Impersonation' },
  { key: 'other',                  label: 'Other' },
];

type Step = 'menu' | 'report_reason' | 'report_desc' | 'report_done';

export const UserSafetySheet: React.FC<Props> = ({
  visible, target, childId, sessionToken, deviceId, onClose, onBlockSuccess,
}) => {
  const [step, setStep]               = useState<Step>('menu');
  const [selectedReason, setReason]   = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting]   = useState(false);

  const reset = () => {
    setStep('menu');
    setReason(null);
    setDescription('');
    setSubmitting(false);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleBlock = () => {
    if (!target) return;
    if (Platform.OS === 'web') {
      if (window.confirm(`Block ${target.displayName}? They won't be able to send you friend or money requests.`)) {
        doBlock();
      }
    } else {
      Alert.alert(
        `Block ${target.displayName}?`,
        "They won't be able to send you friend or money requests, and won't appear in your search results.",
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Block', style: 'destructive', onPress: doBlock },
        ],
      );
    }
  };

  const doBlock = async () => {
    if (!target || !childId || !sessionToken || !deviceId) return;
    try {
      await db.blockUser(childId, sessionToken, deviceId, target.id);
      onBlockSuccess(target.id);
      handleClose();
    } catch (e: any) {
      const msg: string = e?.message ?? '';
      if (msg.includes('active_loan_outstanding')) {
        Alert.alert(
          'Outstanding loan',
          `You can't block ${target.displayName} while you have an active loan between you. Repay or receive repayment first.`,
        );
      } else if (msg.includes('active_request_outstanding')) {
        Alert.alert(
          'Pending money request',
          `You can't block ${target.displayName} while there's an unfunded money request between you. Wait for it to be funded, cancelled, or expire first.`,
        );
      } else {
        Alert.alert('Error', 'Could not block this user. Please try again.');
      }
    }
  };

  const handleSubmitReport = async () => {
    if (!selectedReason || !target || !childId || !sessionToken || !deviceId) return;
    setSubmitting(true);
    try {
      await db.reportUser(childId, sessionToken, deviceId, target.id, selectedReason, description.trim() || undefined);
      setStep('report_done');
    } catch (e: any) {
      Alert.alert('Error', 'Could not submit report. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const renderMenu = () => (
    <>
      <View style={s.sheetHandle} />
      <View style={s.targetRow}>
        <View style={s.targetAvatar}>
          <Text style={s.targetAvatarLetter}>
            {target?.displayName?.[0]?.toUpperCase() ?? '?'}
          </Text>
        </View>
        <View>
          <Text style={s.targetName}>{target?.displayName}</Text>
          <Text style={s.targetHandle}>@{target?.username}</Text>
        </View>
      </View>
      <View style={s.divider} />
      <TouchableOpacity style={s.menuRow} onPress={handleBlock} activeOpacity={0.7}>
        <View style={[s.menuIcon, { backgroundColor: '#FEF2F2' }]}>
          <Ionicons name="ban-outline" size={20} color="#DC2626" />
        </View>
        <Text style={[s.menuLabel, { color: '#DC2626' }]}>Block {target?.displayName}</Text>
      </TouchableOpacity>
      <TouchableOpacity style={s.menuRow} onPress={() => setStep('report_reason')} activeOpacity={0.7}>
        <View style={[s.menuIcon, { backgroundColor: '#FFF7ED' }]}>
          <Ionicons name="flag-outline" size={20} color="#EA580C" />
        </View>
        <Text style={[s.menuLabel, { color: '#EA580C' }]}>Report {target?.displayName}</Text>
      </TouchableOpacity>
      <TouchableOpacity style={s.cancelRow} onPress={handleClose} activeOpacity={0.7}>
        <Text style={s.cancelText}>Cancel</Text>
      </TouchableOpacity>
    </>
  );

  const renderReasonPicker = () => (
    <>
      <View style={s.sheetHandle} />
      <View style={s.stepHeader}>
        <TouchableOpacity onPress={() => setStep('menu')} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="chevron-back" size={24} color="#374151" />
        </TouchableOpacity>
        <Text style={s.stepTitle}>Why are you reporting?</Text>
        <View style={{ width: 24 }} />
      </View>
      <ScrollView showsVerticalScrollIndicator={false}>
        {REPORT_REASONS.map(r => (
          <TouchableOpacity
            key={r.key}
            style={[s.reasonRow, selectedReason === r.key && s.reasonRowSelected]}
            onPress={() => setReason(r.key)}
            activeOpacity={0.7}
          >
            <Text style={[s.reasonLabel, selectedReason === r.key && s.reasonLabelSelected]}>
              {r.label}
            </Text>
            {selectedReason === r.key && (
              <Ionicons name="checkmark-circle" size={20} color="#2E7D32" />
            )}
          </TouchableOpacity>
        ))}
      </ScrollView>
      <View style={s.footer}>
        <TouchableOpacity
          style={[s.nextBtn, !selectedReason && s.nextBtnDisabled]}
          onPress={() => selectedReason && setStep('report_desc')}
          disabled={!selectedReason}
          activeOpacity={0.85}
        >
          <Text style={s.nextBtnText}>Next</Text>
        </TouchableOpacity>
      </View>
    </>
  );

  const renderDescription = () => (
    <>
      <View style={s.sheetHandle} />
      <View style={s.stepHeader}>
        <TouchableOpacity onPress={() => setStep('report_reason')} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="chevron-back" size={24} color="#374151" />
        </TouchableOpacity>
        <Text style={s.stepTitle}>Add details</Text>
        <View style={{ width: 24 }} />
      </View>
      <View style={s.descBody}>
        <Text style={s.descHint}>Optional — describe what happened so we can review it properly.</Text>
        <TextInput
          style={s.descInput}
          value={description}
          onChangeText={setDescription}
          placeholder="What happened?"
          placeholderTextColor="#9CA3AF"
          multiline
          maxLength={500}
          textAlignVertical="top"
        />
        <Text style={s.descCounter}>{description.length}/500</Text>
      </View>
      <View style={s.footer}>
        <TouchableOpacity
          style={[s.nextBtn, submitting && s.nextBtnDisabled]}
          onPress={handleSubmitReport}
          disabled={submitting}
          activeOpacity={0.85}
        >
          {submitting
            ? <ActivityIndicator color="#fff" />
            : <Text style={s.nextBtnText}>Submit report</Text>}
        </TouchableOpacity>
      </View>
    </>
  );

  const renderDone = () => (
    <View style={s.doneWrap}>
      <View style={s.sheetHandle} />
      <View style={s.doneIcon}>
        <Ionicons name="checkmark-circle" size={52} color="#2E7D32" />
      </View>
      <Text style={s.doneTitle}>Report submitted</Text>
      <Text style={s.doneSub}>
        We'll review this and take action if needed. Thank you for helping keep the community safe.
      </Text>
      <TouchableOpacity style={[s.nextBtn, { marginTop: 24 }]} onPress={handleClose} activeOpacity={0.85}>
        <Text style={s.nextBtnText}>Done</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={handleClose}
    >
      <TouchableOpacity style={s.overlay} activeOpacity={1} onPress={handleClose}>
        <TouchableOpacity style={s.sheet} activeOpacity={1} onPress={() => {}}>
          {step === 'menu'          && renderMenu()}
          {step === 'report_reason' && renderReasonPicker()}
          {step === 'report_desc'   && renderDescription()}
          {step === 'report_done'   && renderDone()}
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
};

const s = StyleSheet.create({
  overlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingHorizontal: 20, paddingBottom: 32, maxHeight: '80%',
  },
  sheetHandle: {
    width: 40, height: 4, borderRadius: 2, backgroundColor: '#E5E7EB',
    alignSelf: 'center', marginTop: 12, marginBottom: 20,
  },

  targetRow: {
    flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 20, paddingHorizontal: 4,
  },
  targetAvatar: {
    width: 48, height: 48, borderRadius: 24,
    backgroundColor: '#C8E8CB', alignItems: 'center', justifyContent: 'center',
  },
  targetAvatarLetter: { fontSize: 22, fontWeight: '700', color: '#1A1A3E' },
  targetName:   { fontSize: 16, fontWeight: '700', color: '#1A1A3E' },
  targetHandle: { fontSize: 13, color: '#6B7280', marginTop: 2 },

  divider: { height: 1, backgroundColor: '#F3F4F6', marginBottom: 12 },

  menuRow: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    paddingVertical: 16, paddingHorizontal: 4,
  },
  menuIcon: {
    width: 40, height: 40, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
  },
  menuLabel: { fontSize: 16, fontWeight: '600' },

  cancelRow: {
    alignItems: 'center', paddingVertical: 18,
    marginTop: 4, borderTopWidth: 1, borderTopColor: '#F3F4F6',
  },
  cancelText: { fontSize: 16, fontWeight: '600', color: '#6B7280' },

  stepHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 20, paddingHorizontal: 4,
  },
  stepTitle: { fontSize: 17, fontWeight: '700', color: '#1A1A3E' },

  reasonRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 16, paddingHorizontal: 12, borderRadius: 12,
    marginBottom: 4,
  },
  reasonRowSelected: { backgroundColor: '#F0FDF4' },
  reasonLabel:       { fontSize: 15, fontWeight: '500', color: '#374151', flex: 1 },
  reasonLabelSelected: { color: '#166534', fontWeight: '600' },

  descBody: { gap: 10 },
  descHint: { fontSize: 14, color: '#6B7280', lineHeight: 20 },
  descInput: {
    height: 120, borderWidth: 1.5, borderColor: '#E5E7EB', borderRadius: 12,
    padding: 14, fontSize: 15, color: '#1A1A3E', backgroundColor: '#F9FAFB',
  },
  descCounter: { fontSize: 12, color: '#9CA3AF', textAlign: 'right' },

  footer: { paddingTop: 20 },
  nextBtn: {
    backgroundColor: '#1A1A3E', borderRadius: 50,
    paddingVertical: 16, alignItems: 'center',
  },
  nextBtnDisabled: { opacity: 0.45 },
  nextBtnText: { fontSize: 16, fontWeight: '700', color: '#fff' },

  doneWrap: { alignItems: 'center', paddingVertical: 20, paddingHorizontal: 4 },
  doneIcon:  { marginBottom: 16 },
  doneTitle: { fontSize: 22, fontWeight: '800', color: '#1A1A3E', marginBottom: 10 },
  doneSub: {
    fontSize: 15, color: '#6B7280', textAlign: 'center', lineHeight: 22,
    paddingHorizontal: 8,
  },
});
