// SPDX-License-Identifier: GPL-3.0-only
import React, { createContext, useContext, useEffect } from 'react';
import {
  Animated,
  useAnimatedValue,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
export const light = {
  bg: '#f4f5f6',
  surface: '#ffffff',
  ink: '#121316',
  muted: '#626873',
  line: '#d8dce1',
  accent: '#345a7e',
  onAccent: '#ffffff',
  danger: '#a33131',
};
export const dark = {
  bg: '#121316',
  surface: '#1d2025',
  ink: '#f1f2f4',
  muted: '#afb5be',
  line: '#3b414b',
  accent: '#9ab9d6',
  onAccent: '#111820',
  danger: '#f1a4a4',
};
export const Theme = createContext({
  colors: light,
  busy: false,
  reduceMotion: false,
});
export const s = StyleSheet.create({
  page: { flex: 1 },
  content: { padding: 16, gap: 16 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  card: { borderWidth: 1, borderRadius: 16, padding: 16, gap: 12 },
  h1: { fontSize: 22, fontWeight: '700' },
  h2: { fontSize: 18, fontWeight: '600' },
  body: { fontSize: 14, lineHeight: 22 },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    fontSize: 16,
  },
  button: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 11,
    minHeight: 48,
    justifyContent: 'center',
    alignItems: 'center',
  },
  nav: { flexDirection: 'row', borderTopWidth: 1, padding: 8, gap: 4 },
  navItem: {
    flex: 1,
    minHeight: 48,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 10,
  },
  track: {
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
    flexDirection: 'row',
  },
  column: { flexGrow: 1, flexBasis: 300, gap: 16 },
});
export function Button({
  label,
  onPress,
  disabled = false,
  primary = false,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  primary?: boolean;
  accessibilityLabel?: string;
}) {
  const { colors: c, busy, reduceMotion } = useContext(Theme);
  const scale = useAnimatedValue(1);
  useEffect(() => {
    if (reduceMotion) {
      scale.stopAnimation();
      scale.setValue(1);
    }
  }, [reduceMotion, scale]);
  const feedback = (pressed: boolean) => {
    if (reduceMotion) return;
    Animated.timing(scale, {
      toValue: pressed ? 0.97 : 1,
      duration: 90,
      useNativeDriver: true,
    }).start();
  };
  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label}
        accessibilityState={{ disabled: disabled || busy, selected: primary }}
        disabled={disabled || busy}
        onPress={onPress}
        onPressIn={() => feedback(true)}
        onPressOut={() => feedback(false)}
        style={({ pressed }) => [
          s.button,
          {
            borderColor: c.line,
            backgroundColor: primary ? c.accent : c.surface,
            opacity: disabled || busy ? 0.45 : pressed ? 0.87 : 1,
          },
        ]}
      >
        <Text
          style={{ color: primary ? c.onAccent : c.ink, fontWeight: '600' }}
        >
          {label}
        </Text>
      </Pressable>
    </Animated.View>
  );
}
export function ModalPage({
  title,
  onClose,
  children,
  footer,
  scroll = true,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  scroll?: boolean;
}) {
  const { colors: c, reduceMotion } = useContext(Theme);
  const insets = useSafeAreaInsets();
  return (
    <Modal
      animationType={reduceMotion ? 'none' : 'slide'}
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        style={{
          flex: 1,
          backgroundColor: c.bg,
          paddingTop: insets.top,
          paddingBottom: insets.bottom,
        }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View
          style={{
            paddingHorizontal: 16,
            paddingVertical: 12,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            borderBottomWidth: 1,
            borderColor: c.line,
          }}
        >
          <Button
            label="返回"
            accessibilityLabel={'返回 ' + title}
            onPress={onClose}
          />
          <Text style={[s.h1, { color: c.ink, flex: 1 }]}>{title}</Text>
        </View>
        {scroll ? (
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={s.content}
          >
            {children}
          </ScrollView>
        ) : (
          <View style={{ flex: 1, padding: 16, gap: 12 }}>{children}</View>
        )}
        {footer && (
          <View
            style={{
              padding: 16,
              gap: 8,
              borderTopWidth: 1,
              borderColor: c.line,
              backgroundColor: c.surface,
            }}
          >
            {footer}
          </View>
        )}
      </KeyboardAvoidingView>
    </Modal>
  );
}
export function PageTransition({
  identity,
  children,
}: {
  identity: string;
  children: React.ReactNode;
}) {
  const { reduceMotion } = useContext(Theme);
  const opacity = useAnimatedValue(1);
  useEffect(() => {
    if (reduceMotion) {
      opacity.setValue(1);
      return;
    }
    opacity.setValue(0.90);
    const animation = Animated.timing(opacity, {
      toValue: 1,
      duration: 90,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [identity, opacity, reduceMotion]);
  return <Animated.View style={{ opacity, gap: 16 }}>{children}</Animated.View>;
}
export function HelpLink({
  label,
  onPress,
}: {
  label: string;
  onPress: () => void;
}) {
  const { colors: c, busy } = useContext(Theme);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={busy}
      onPress={onPress}
      style={({ pressed }) => ({
        alignSelf: 'flex-start',
        minHeight: 48,
        paddingHorizontal: 8,
        justifyContent: 'center',
        opacity: busy ? 0.45 : pressed ? 0.65 : 1,
      })}
    >
      <Text style={[s.body, { color: c.accent }]}>ⓘ {label}</Text>
    </Pressable>
  );
}
export function ProgressBar({ ratio }: { ratio: number }) {
  const { colors: c, reduceMotion } = useContext(Theme);
  const progress = useAnimatedValue(ratio);
  useEffect(() => {
    const bounded = Math.max(0, Math.min(1, ratio));
    if (reduceMotion) {
      progress.setValue(bounded);
      return;
    }
    const animation = Animated.timing(progress, {
      toValue: bounded,
      duration: 220,
      useNativeDriver: false,
    });
    animation.start();
    return () => animation.stop();
  }, [ratio, reduceMotion, progress]);
  return (
    <View
      style={[s.track, { backgroundColor: c.line }]}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(ratio * 100) }}
    >
      <Animated.View
        style={{
          height: 6,
          backgroundColor: c.accent,
          width: progress.interpolate({
            inputRange: [0, 1],
            outputRange: ['0%', '100%'],
          }),
        }}
      />
    </View>
  );
}
export function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const { colors: c } = useContext(Theme);
  return (
    <View style={[s.card, { backgroundColor: c.surface, borderColor: c.line }]}>
      <Text style={[s.h2, { color: c.ink }]}>{title}</Text>
      {children}
    </View>
  );
}
export function Input({
  label,
  value,
  onChange,
  multiline = false,
  maxLength = 4000,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
  maxLength?: number;
}) {
  const { colors: c, busy } = useContext(Theme);
  return (
    <View style={{ gap: 6 }}>
      <Text style={[s.body, { color: c.muted }]}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        editable={!busy}
        accessibilityState={{ disabled: busy }}
        value={value}
        onChangeText={onChange}
        multiline={multiline}
        maxLength={maxLength}
        style={[
          s.input,
          {
            color: c.ink,
            borderColor: c.line,
            minHeight: multiline ? 100 : 46,
          },
        ]}
        placeholderTextColor={c.muted}
      />
    </View>
  );
}
