import { useColorScheme } from '@/shared/ui/hooks/use-color-scheme';
import { Colors } from '@/shared/ui/theme';

export function useTheme() {
  const scheme = useColorScheme();
  const theme = scheme === 'dark' ? 'dark' : 'light';

  return Colors[theme];
}
