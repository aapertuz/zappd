import {
  Button,
  Host,
  HStack,
  Image,
  Rectangle,
  TextField,
  type TextFieldRef,
  useNativeState,
  VStack,
} from '@expo/ui/swift-ui';
import {
  accessibilityLabel,
  background,
  buttonStyle,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  onSubmit as onSubmitModifier,
  onTapGesture,
  opacity,
  padding,
  shadow,
  shapes,
  strokeBorder,
  submitLabel,
  textFieldStyle,
  tint,
} from '@expo/ui/swift-ui/modifiers';
import { useEffect, useState } from 'react';
import { StyleSheet } from 'react-native';

import { CANVAS_COLORS, CANVAS_LAYOUT } from '../constants/canvasTokens';
import { type CanvasViewProps } from '../types';

export function CanvasView({ draft, canSubmit, onDraftChange, onSubmit }: CanvasViewProps) {
  const [textField, setTextField] = useState<TextFieldRef | null>(null);
  const textState = useNativeState(draft);

  useEffect(() => {
    if (draft === '' && textState.get() !== '') {
      textState.set('');
      void textField?.clear();
    }
  }, [draft, textField, textState]);

  function handleSubmit() {
    if (!canSubmit) return;
    onSubmit();
    textState.set('');
    void textField?.clear();
  }

  function handleDismissKeyboard() {
    void textField?.blur();
  }

  return (
    <Host style={styles.host} colorScheme="light">
      <VStack
        spacing={0}
        modifiers={[
          frame({ maxWidth: Infinity, maxHeight: Infinity }),
          background(CANVAS_COLORS.background),
        ]}>
        <Rectangle
          modifiers={[
            frame({ maxWidth: Infinity, maxHeight: Infinity }),
            opacity(0.001),
            onTapGesture(handleDismissKeyboard),
          ]}
        />
        <HStack
          alignment="bottom"
          spacing={CANVAS_LAYOUT.composerGap}
          modifiers={[
            padding({
              top: CANVAS_LAYOUT.composerInnerPaddingVertical,
              bottom: CANVAS_LAYOUT.composerInnerPaddingVertical,
              leading: CANVAS_LAYOUT.composerInnerPaddingStart,
              trailing: CANVAS_LAYOUT.composerInnerPaddingEnd,
            }),
            background(
              CANVAS_COLORS.composerSurface,
              shapes.roundedRectangle({
                cornerRadius: CANVAS_LAYOUT.composerCornerRadius,
                roundedCornerStyle: 'continuous',
              }),
            ),
            strokeBorder({
              content: CANVAS_COLORS.composerBorder,
              style: { lineWidth: 1 },
              shape: 'roundedRectangle',
              cornerRadius: CANVAS_LAYOUT.composerCornerRadius,
            }),
            shadow({ radius: 12, y: 4, color: CANVAS_COLORS.composerShadow }),
            frame({ maxWidth: CANVAS_LAYOUT.composerMaxWidth }),
            padding({ horizontal: CANVAS_LAYOUT.composerHorizontalInset, bottom: 12 }),
          ]}>
          <TextField
            ref={setTextField}
            text={textState}
            axis="vertical"
            onTextChange={onDraftChange}
            modifiers={[
              textFieldStyle('plain'),
              font({ size: CANVAS_LAYOUT.inputFontSize }),
              foregroundStyle(CANVAS_COLORS.text),
              tint(CANVAS_COLORS.text),
              lineLimit({ min: 1, max: CANVAS_LAYOUT.inputMaxLines }),
              padding({ vertical: 8 }),
              frame({ maxWidth: Infinity, alignment: 'leading' }),
              submitLabel('send'),
              onSubmitModifier(handleSubmit),
              accessibilityLabel('Prompt input'),
            ]}
          />
          <Button
            onPress={handleSubmit}
            modifiers={[buttonStyle('plain'), accessibilityLabel('Send')]}>
            <Image
              systemName="arrow.up"
              size={17}
              color={canSubmit ? CANVAS_COLORS.buttonIcon : CANVAS_COLORS.buttonIconMuted}
              modifiers={[
                font({ size: 16, weight: 'semibold' }),
                frame({ width: CANVAS_LAYOUT.buttonSize, height: CANVAS_LAYOUT.buttonSize }),
                background(CANVAS_COLORS.primaryButton, shapes.circle()),
              ]}
            />
          </Button>
        </HStack>
      </VStack>
    </Host>
  );
}

const styles = StyleSheet.create({
  host: {
    flex: 1,
    backgroundColor: CANVAS_COLORS.background,
  },
});
