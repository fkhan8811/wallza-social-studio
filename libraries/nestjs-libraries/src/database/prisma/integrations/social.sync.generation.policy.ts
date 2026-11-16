export type SocialSyncAction = 'upsert' | 'disconnect';

export interface SocialSyncGenerationState {
  generation: number;
  lastAction: string;
}

export type SocialSyncGenerationDecision =
  | {
      allowed: true;
      currentGeneration: number;
      shouldInsert: boolean;
      shouldAdvance: boolean;
      replayed: boolean;
    }
  | {
      allowed: false;
      currentGeneration: number;
      reason: 'invalid_generation' | 'superseded' | 'conflict';
    };

/**
 * Pure decision policy used inside the serializable PostgreSQL transaction.
 * The account mutation itself must remain inside that same transaction.
 */
export function decideSocialSyncGeneration(
  current: SocialSyncGenerationState | null,
  incomingGeneration: number,
  action: SocialSyncAction
): SocialSyncGenerationDecision {
  if (!Number.isSafeInteger(incomingGeneration) || incomingGeneration <= 0) {
    return {
      allowed: false,
      currentGeneration: current?.generation || 0,
      reason: 'invalid_generation',
    };
  }

  if (current && incomingGeneration < current.generation) {
    return {
      allowed: false,
      currentGeneration: current.generation,
      reason: 'superseded',
    };
  }

  if (
    current &&
    incomingGeneration === current.generation &&
    current.lastAction !== action
  ) {
    return {
      allowed: false,
      currentGeneration: current.generation,
      reason: 'conflict',
    };
  }

  return {
    allowed: true,
    currentGeneration: incomingGeneration,
    shouldInsert: !current,
    shouldAdvance: !!current && incomingGeneration > current.generation,
    replayed: !!current && incomingGeneration === current.generation,
  };
}
