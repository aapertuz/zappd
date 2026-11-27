import { Image } from 'expo-image';
import { useLayoutEffect, useReducer, useRef } from 'react';

import { type CatalogArchetypeId } from '@/shared/domain';

import classes from './AssemblySelectorView.web.module.css';
import { useCatalogTurntable } from './useCatalogTurntable';
import { previewImages } from '../assets/previewImages';
import { createInitialSelectorState, reduceSelectorState } from '../model/selectorState';
import { type AssemblySelectorViewProps } from '../types';

export function AssemblySelectorView({ cards, onSelectAssembly }: AssemblySelectorViewProps) {
  const [state, dispatch] = useReducer(reduceSelectorState, undefined, createInitialSelectorState);
  const gallery = useRef<HTMLElement>(null);
  const mounts = useRef(new Map<CatalogArchetypeId, HTMLSpanElement>());
  useCatalogTurntable(cards, state, mounts);

  useLayoutEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const updatePreference = () =>
      dispatch({ type: 'setReducedMotion', reducedMotion: media.matches });
    updatePreference();
    media.addEventListener('change', updatePreference);
    return () => media.removeEventListener('change', updatePreference);
  }, []);

  useLayoutEffect(() => {
    if (gallery.current === null) return;
    const ids = new Map(cards.map(({ archetypeId }) => [String(archetypeId), archetypeId]));
    const observer = new IntersectionObserver((entries) => {
      const changes = new Map<CatalogArchetypeId, boolean>();
      for (const { target, isIntersecting } of entries) {
        const archetypeId = ids.get(target.getAttribute('data-archetype-id') ?? '');
        if (archetypeId !== undefined) changes.set(archetypeId, isIntersecting);
      }
      dispatch({ type: 'setVisibility', changes });
    });
    for (const card of gallery.current.querySelectorAll('[data-archetype-id]'))
      observer.observe(card);
    return () => observer.disconnect();
  }, [cards]);

  return (
    <main className={classes.catalog} aria-label="Assembly catalog" ref={gallery}>
      <div className={classes.content}>
        <header className={classes.header}>
          <h1>Choose an assembly</h1>
          <p>Open a CAD model to explore its parts and how they fit together.</p>
        </header>
        <div className={classes.grid}>
          {cards.map(
            ({ archetypeId, commercialName, technicalTitle, partCount, category, badge }) => {
              const activate = () => dispatch({ type: 'activateTurntable', archetypeId });
              return (
                <button
                  key={archetypeId}
                  type="button"
                  className={classes.card}
                  aria-labelledby={`${archetypeId}-name`}
                  aria-describedby={`${archetypeId}-title ${archetypeId}-metadata${badge === 'source_inspection' ? ` ${archetypeId}-badge` : ''}`}
                  data-archetype-id={archetypeId}
                  data-visible={state.visibleCardIds.includes(archetypeId)}
                  onPointerEnter={(event) => {
                    if (event.pointerType !== 'touch') activate();
                  }}
                  onFocus={activate}
                  onClick={() => onSelectAssembly(archetypeId)}>
                  <span className={classes.preview} aria-hidden="true">
                    <span className={classes.previewImage}>
                      <Image
                        source={previewImages[archetypeId]}
                        style={{ width: '100%', height: '100%' }}
                        contentFit="contain"
                      />
                    </span>
                    <span
                      className={classes.livePreview}
                      ref={(element) => {
                        if (element === null) mounts.current.delete(archetypeId);
                        else mounts.current.set(archetypeId, element);
                      }}
                    />
                  </span>
                  <span className={classes.details}>
                    <span className={classes.metadata} id={`${archetypeId}-metadata`}>
                      <span>{category}</span>
                      <span>{partCount} parts</span>
                    </span>
                    <span className={classes.name} id={`${archetypeId}-name`}>
                      {commercialName}
                    </span>
                    <span className={classes.technical} id={`${archetypeId}-title`}>
                      {technicalTitle}
                    </span>
                    {badge === 'source_inspection' && (
                      <span className={classes.badge} id={`${archetypeId}-badge`}>
                        Source Inspection
                      </span>
                    )}
                  </span>
                </button>
              );
            },
          )}
        </div>
      </div>
    </main>
  );
}
