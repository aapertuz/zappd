import { Image } from 'expo-image';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { previewImages } from '../assets/previewImages';
import { type AssemblySelectorViewProps } from '../types';

export function AssemblySelectorView({ cards, onSelectAssembly }: AssemblySelectorViewProps) {
  const { width } = useWindowDimensions();

  return (
    <SafeAreaView style={styles.surface}>
      <ScrollView accessibilityLabel="Assembly catalog" contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={styles.heading}>
          Choose an assembly
        </Text>
        <Text style={styles.description}>
          Open a CAD model to explore its parts and how they fit together.
        </Text>
        <View style={styles.grid}>
          {cards.map(
            ({ archetypeId, commercialName, technicalTitle, partCount, category, badge }) => (
              <Pressable
                key={archetypeId}
                accessibilityRole="button"
                accessibilityLabel={`${commercialName}, ${technicalTitle}, ${partCount} parts${badge === 'source_inspection' ? ', Source Inspection' : ''}`}
                onPress={() => onSelectAssembly(archetypeId)}
                style={({ pressed }) => [
                  styles.card,
                  width >= 720 && styles.tabletCard,
                  pressed && styles.pressed,
                ]}>
                <View style={styles.preview}>
                  <Image
                    source={previewImages[archetypeId]}
                    style={styles.image}
                    contentFit="contain"
                  />
                </View>
                <View style={styles.details}>
                  <View style={styles.metadata}>
                    <Text style={styles.micro}>{category}</Text>
                    <Text style={styles.micro}>{partCount} parts</Text>
                  </View>
                  <Text style={styles.name}>{commercialName}</Text>
                  <Text style={styles.technical}>{technicalTitle}</Text>
                  {badge === 'source_inspection' && (
                    <Text style={styles.badge}>Source Inspection</Text>
                  )}
                </View>
              </Pressable>
            ),
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  surface: {
    flex: 1,
    backgroundColor: '#08080B',
  },
  content: {
    width: '100%',
    maxWidth: 980,
    alignSelf: 'center',
    paddingHorizontal: 20,
    paddingTop: 26,
    paddingBottom: 28,
  },
  heading: {
    color: '#FAF6ED',
    fontSize: 37,
    fontWeight: '700',
    letterSpacing: -1.7,
  },
  description: {
    color: '#B9AC99',
    fontSize: 14,
    lineHeight: 21,
    marginTop: 8,
    marginBottom: 23,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: 14,
  },
  card: {
    width: '100%',
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#F5C45160',
    borderRadius: 15,
    backgroundColor: '#12110E',
  },
  tabletCard: {
    width: '49%',
  },
  pressed: {
    borderColor: '#F5C451',
    backgroundColor: '#231D12',
  },
  preview: {
    aspectRatio: 1.6,
    overflow: 'hidden',
    backgroundColor: '#191612',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  details: {
    flex: 1,
    paddingHorizontal: 15,
    paddingBottom: 15,
  },
  metadata: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    columnGap: 8,
    marginTop: 12,
    marginBottom: 7,
  },
  micro: {
    color: '#DEBA75',
    fontFamily: 'monospace',
    fontSize: 9,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  name: {
    color: '#FAF6ED',
    fontSize: 24,
    fontWeight: '700',
    letterSpacing: -0.6,
  },
  technical: {
    color: '#B9AC99',
    fontSize: 13,
    marginTop: 3,
  },
  badge: {
    alignSelf: 'flex-start',
    marginTop: 10,
    paddingHorizontal: 7,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: '#F5C45160',
    borderRadius: 5,
    color: '#F5C451',
    fontFamily: 'monospace',
    fontSize: 10,
  },
});
