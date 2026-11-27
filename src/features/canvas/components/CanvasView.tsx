import {
  Host,
  Icon,
  Row,
  Spacer,
  TextInput,
  type TextInputRef,
  type UniversalStyle,
  useNativeState,
} from '@expo/ui';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import arrowUpIcon from '../assets/arrow-up.xml';
import { CANVAS_COLORS, CANVAS_LAYOUT } from '../constants/canvasTokens';
import { type CanvasViewProps } from '../types';

const SEND_ICON = Icon.select({ ios: 'arrow.up', android: arrowUpIcon });

const NATIVE_INPUT_STYLE: UniversalStyle = {
  width: '100%',
  paddingVertical: 8,
};

const SEND_BUTTON_STYLE: UniversalStyle = {
  width: CANVAS_LAYOUT.buttonSize,
  height: CANVAS_LAYOUT.buttonSize,
  borderRadius: CANVAS_LAYOUT.buttonSize / 2,
  backgroundColor: CANVAS_COLORS.primaryButton,
};

export function CanvasView({
  draft,
  placeholder = 'Describe a CAD assembly to explore...',
  canSubmit,
  surfaceContent,
  notice,
  onDismissNotice,
  onDraftChange,
  onSubmit,
}: CanvasViewProps) {
  const [textInput, setTextInput] = useState<TextInputRef | null>(null);
  const textState = useNativeState(draft);

  useEffect(() => {
    if (draft === '' && textState.get() !== '') {
      textState.set('');
      textInput?.clear();
    }
  }, [draft, textInput, textState]);

  function handleSubmit() {
    if (!canSubmit) return;
    onSubmit();
    textState.set('');
    textInput?.clear();
  }

  function handleDismissKeyboard() {
    textInput?.blur();
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom', 'left', 'right']}>
      <KeyboardAvoidingView
        style={styles.keyboardContainer}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        {surfaceContent !== undefined && surfaceContent !== null ? (
          <View style={styles.dismissArea}>{surfaceContent}</View>
        ) : (
          <Pressable style={styles.dismissArea} onPress={handleDismissKeyboard} />
        )}
        <View style={styles.composerDock}>
          {notice !== null ? (
            <View style={styles.notice}>
              <Text
                accessibilityRole="alert"
                accessibilityLiveRegion="polite"
                style={styles.noticeText}>
                {notice}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Dismiss notice"
                onPress={onDismissNotice}
                hitSlop={8}
                style={styles.dismissNotice}>
                <Text style={styles.dismissNoticeText}>×</Text>
              </Pressable>
            </View>
          ) : null}
          <View style={styles.composer}>
            <Host style={styles.inputHost} matchContents={{ vertical: true }} colorScheme="dark">
              <TextInput
                ref={setTextInput}
                value={textState}
                onChangeText={onDraftChange}
                multiline
                returnKeyType="send"
                onSubmitEditing={handleSubmit}
                cursorColor={CANVAS_COLORS.text}
                accessibilityLabel="Prompt input"
                placeholder={placeholder}
                textStyle={{
                  color: CANVAS_COLORS.text,
                  fontSize: CANVAS_LAYOUT.inputFontSize,
                  lineHeight: CANVAS_LAYOUT.inputLineHeight,
                }}
                style={NATIVE_INPUT_STYLE}
              />
            </Host>
            <Host
              matchContents
              colorScheme="dark"
              accessibilityRole="button"
              accessibilityLabel="Send">
              <Row alignment="center" onPress={handleSubmit} style={SEND_BUTTON_STYLE}>
                <Spacer flexible />
                <Icon
                  name={SEND_ICON}
                  size={18}
                  color={canSubmit ? CANVAS_COLORS.buttonIcon : CANVAS_COLORS.buttonIconMuted}
                  accessibilityLabel="Send"
                />
                <Spacer flexible />
              </Row>
            </Host>
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: CANVAS_COLORS.background,
  },
  keyboardContainer: {
    flex: 1,
  },
  dismissArea: {
    flex: 1,
  },
  composerDock: {
    width: '100%',
    maxWidth: CANVAS_LAYOUT.composerMaxWidth,
    alignSelf: 'center',
    paddingHorizontal: CANVAS_LAYOUT.composerHorizontalInset,
    paddingBottom: 12,
  },
  notice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
    paddingLeft: 14,
    paddingRight: 6,
    paddingVertical: 4,
    backgroundColor: '#211b12',
    borderColor: CANVAS_COLORS.composerBorder,
    borderWidth: 1,
    borderRadius: 16,
  },
  noticeText: {
    flex: 1,
    color: '#f4dfad',
    fontSize: 13,
    lineHeight: 19,
  },
  dismissNotice: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dismissNoticeText: {
    color: '#f4dfad',
    fontSize: 22,
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: CANVAS_LAYOUT.composerGap,
    backgroundColor: CANVAS_COLORS.composerSurface,
    borderRadius: CANVAS_LAYOUT.composerCornerRadius,
    borderWidth: 1,
    borderColor: CANVAS_COLORS.composerBorder,
    paddingLeft: CANVAS_LAYOUT.composerInnerPaddingStart,
    paddingRight: CANVAS_LAYOUT.composerInnerPaddingEnd,
    paddingVertical: CANVAS_LAYOUT.composerInnerPaddingVertical,
    boxShadow: `0px 4px 12px ${CANVAS_COLORS.composerShadow}`,
  },
  inputHost: {
    flex: 1,
    maxHeight: CANVAS_LAYOUT.inputLineHeight * CANVAS_LAYOUT.inputMaxLines + 16,
    overflow: 'hidden',
  },
});
