import {
  BasicTextField,
  type BasicTextFieldRef,
  Box,
  Column,
  FilledIconButton,
  Host,
  Icon,
  Row,
  Shape,
  Surface,
  useNativeState,
} from '@expo/ui/jetpack-compose';
import {
  background,
  clickable,
  fillMaxSize,
  fillMaxWidth,
  imePadding,
  padding,
  semantics,
  size,
  weight,
} from '@expo/ui/jetpack-compose/modifiers';
import { useEffect, useState } from 'react';
import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import arrowUpIcon from '../assets/arrow-up.xml';
import { CANVAS_COLORS, CANVAS_LAYOUT } from '../constants/canvasTokens';
import { type CanvasViewProps } from '../types';

const COMPOSER_SHAPE = Shape.RoundedCorner({
  cornerRadii: {
    topStart: CANVAS_LAYOUT.composerCornerRadius,
    topEnd: CANVAS_LAYOUT.composerCornerRadius,
    bottomStart: CANVAS_LAYOUT.composerCornerRadius,
    bottomEnd: CANVAS_LAYOUT.composerCornerRadius,
  },
});

const SEND_BUTTON_SHAPE = Shape.Circle({});

export function CanvasView({ draft, canSubmit, onDraftChange, onSubmit }: CanvasViewProps) {
  const [textField, setTextField] = useState<BasicTextFieldRef | null>(null);
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
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom', 'left', 'right']}>
      <Host style={styles.host} colorScheme="light">
        <Column
          modifiers={[
            fillMaxSize(),
            background(CANVAS_COLORS.background),
            imePadding(),
            padding(
              CANVAS_LAYOUT.composerHorizontalInset,
              16,
              CANVAS_LAYOUT.composerHorizontalInset,
              16,
            ),
          ]}>
          <Box
            modifiers={[
              fillMaxWidth(),
              weight(1),
              clickable(handleDismissKeyboard, { indication: false }),
            ]}
          />
          <Surface
            color={CANVAS_COLORS.composerSurface}
            shape={COMPOSER_SHAPE}
            border={{ width: 1, color: CANVAS_COLORS.composerBorder }}
            shadowElevation={3}
            modifiers={[fillMaxWidth()]}>
            <Row
              verticalAlignment="bottom"
              horizontalArrangement={{ spacedBy: CANVAS_LAYOUT.composerGap }}
              modifiers={[
                fillMaxWidth(),
                padding(
                  CANVAS_LAYOUT.composerInnerPaddingStart,
                  CANVAS_LAYOUT.composerInnerPaddingVertical,
                  CANVAS_LAYOUT.composerInnerPaddingEnd,
                  CANVAS_LAYOUT.composerInnerPaddingVertical,
                ),
              ]}>
              <BasicTextField
                ref={setTextField}
                value={textState}
                onValueChange={onDraftChange}
                cursorColor={CANVAS_COLORS.text}
                maxLines={CANVAS_LAYOUT.inputMaxLines}
                textStyle={{
                  color: CANVAS_COLORS.text,
                  fontSize: CANVAS_LAYOUT.inputFontSize,
                  lineHeight: CANVAS_LAYOUT.inputLineHeight,
                }}
                keyboardOptions={{ capitalization: 'sentences', imeAction: 'send' }}
                keyboardActions={{ onSend: handleSubmit }}
                modifiers={[
                  weight(1),
                  padding(0, 8, 0, 8),
                  semantics({ contentDescription: 'Prompt input' }),
                ]}>
                <BasicTextField.DecorationBox>
                  <Box modifiers={[fillMaxWidth()]}>
                    <BasicTextField.InnerTextField />
                  </Box>
                </BasicTextField.DecorationBox>
              </BasicTextField>
              <FilledIconButton
                onClick={handleSubmit}
                enabled={canSubmit}
                shape={SEND_BUTTON_SHAPE}
                colors={{
                  containerColor: CANVAS_COLORS.primaryButton,
                  contentColor: CANVAS_COLORS.buttonIcon,
                  disabledContainerColor: CANVAS_COLORS.primaryButton,
                  disabledContentColor: CANVAS_COLORS.buttonIconMuted,
                }}
                modifiers={[size(CANVAS_LAYOUT.buttonSize, CANVAS_LAYOUT.buttonSize)]}>
                <Icon source={arrowUpIcon} size={20} contentDescription="Send" />
              </FilledIconButton>
            </Row>
          </Surface>
        </Column>
      </Host>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: CANVAS_COLORS.background,
  },
  host: {
    flex: 1,
  },
});
