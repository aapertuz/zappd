import '@/shared/ui/global.css';

import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { CANVAS_COLORS } from '@/features/canvas';

export default function RootLayout() {
  return (
    <>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: CANVAS_COLORS.background },
        }}>
        <Stack.Screen name="index" />
      </Stack>
    </>
  );
}
