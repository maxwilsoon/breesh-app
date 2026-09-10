import React, { useState } from 'react';
import {
  View, Text, StyleSheet, KeyboardAvoidingView, Platform,
  TextInput, TouchableOpacity, ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../navigation/types';
import { StepProgress } from '../../components/StepProgress';
import { BackButton } from '../../components/BackButton';
import { useApp } from '../../context/AppContext';

const GREEN = '#C8E8CB';
const GREEN_DARK = '#3D7A45';
const BG = '#F2F2F7';

const rules = [
  { label: 'At least 8 characters',  test: (p: string) => p.length >= 8 },
  { label: 'One uppercase letter',   test: (p: string) => /[A-Z]/.test(p) },
  { label: 'One lowercase letter',   test: (p: string) => /[a-z]/.test(p) },
  { label: 'One number',             test: (p: string) => /\d/.test(p) },
];

// One fixed message whenever the password fails any rule — it always lists
// every requirement, so people see the same thing regardless of which part
// is missing.
const STRENGTH_MESSAGE =
  "That password isn't strong enough — it needs at least 8 characters, " +
  'including an uppercase letter, a lowercase letter and a number.';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Password'> };

export const PasswordScreen: React.FC<Props> = ({ navigation }) => {
  const { setOnboardingPassword } = useApp();
  const [password, setPassword]       = useState('');
  const [confirm, setConfirm]         = useState('');
  const [showPass, setShowPass]       = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const unmet = rules.filter(r => !r.test(password));
  const bothFilled = password.length > 0 && confirm.length > 0;
  const passwordsMatch = bothFilled && password === confirm;

  // Feedback shown under the confirm box. Nothing shows until both boxes are
  // filled: once they match we check strength; if they don't match (and the
  // confirm box is at least as long as the password) we flag the mismatch.
  const fieldError =
    passwordsMatch && unmet.length > 0
      ? STRENGTH_MESSAGE
      : bothFilled && confirm.length >= password.length && password !== confirm
        ? "Passwords don't match."
        : '';

  const canContinue = passwordsMatch && unmet.length === 0;

  const proceed = () => {
    setOnboardingPassword(password);
    navigation.navigate('Mobile');
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <BackButton />
      <StepProgress current={2} total={8} />

      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>

          <Text style={styles.title}>Create a password</Text>
          <Text style={styles.sub}>For secure log in to your parent account.</Text>

          {/* Password field */}
          <View style={styles.inputWrap}>
            <TextInput
              style={styles.input}
              placeholder="Create a password"
              placeholderTextColor="#AEAEB2"
              value={password}
              onChangeText={setPassword}
              secureTextEntry={!showPass}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
            />
            <TouchableOpacity onPress={() => setShowPass(v => !v)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name={showPass ? 'eye-off-outline' : 'eye-outline'} size={22} color="#AEAEB2" />
            </TouchableOpacity>
          </View>

          {/* Confirm field */}
          <View style={[styles.inputWrap, !!fieldError && styles.inputError]}>
            <TextInput
              style={styles.input}
              placeholder="Confirm password"
              placeholderTextColor="#AEAEB2"
              value={confirm}
              onChangeText={setConfirm}
              secureTextEntry={!showConfirm}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TouchableOpacity onPress={() => setShowConfirm(v => !v)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name={showConfirm ? 'eye-off-outline' : 'eye-outline'} size={22} color="#AEAEB2" />
            </TouchableOpacity>
          </View>
          {!!fieldError && <Text style={styles.errorText}>{fieldError}</Text>}

          <View style={{ flex: 1, minHeight: 24 }} />

          {/* Footer */}
          <View style={styles.footer}>
            <TouchableOpacity
              style={[styles.btn, !canContinue && styles.btnDisabled]}
              onPress={proceed}
              disabled={!canContinue}
              activeOpacity={0.85}
            >
              <Text style={styles.btnText}>Continue</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: BG },
  scroll: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 20, paddingBottom: 16 },

  title: { fontSize: 32, fontWeight: '800', color: '#1C1C1E', marginBottom: 6 },
  sub:   { fontSize: 16, color: '#3C3C43', marginBottom: 28, lineHeight: 22 },

  inputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: '#D1D1D6',
    paddingHorizontal: 16,
    paddingVertical: 18,
    marginBottom: 14,
  },
  inputError: { borderColor: '#FF3B30' },
  input:      { flex: 1, fontSize: 17, color: '#1C1C1E' },
  errorText:  { color: '#FF3B30', fontSize: 13, marginTop: -8, marginBottom: 12, marginLeft: 4 },

  footer: { paddingBottom: 12, paddingTop: 8 },
  btn: {
    backgroundColor: GREEN,
    borderRadius: 50,
    paddingVertical: 18,
    alignItems: 'center',
  },
  btnDisabled: { opacity: 0.45 },
  btnText:     { color: '#1F2937', fontSize: 17, fontWeight: '700' },
});
