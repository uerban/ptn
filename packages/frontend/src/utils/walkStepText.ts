import type { WalkingNextStep } from "@pt/shared";

type Translate = (key: string, fallback?: string) => string;

const TURN_TEXT: Record<string, string> = {
  straight: "Continue",
  "slight-left": "Turn slightly left",
  "slight-right": "Turn slightly right",
  left: "Turn left",
  right: "Turn right",
  "sharp-left": "Turn sharp left",
  "sharp-right": "Turn sharp right",
  "u-turn": "Turn around",
};

/** Separator between the parts; punctuation, not translated. */
export const WALK_STEP_SEPARATOR = " · ";

export interface WalkStepParts {
  /** "42 m" */
  distance: string;
  /** One or two standalone imperatives: "Turn left", "Cross the street". */
  actions: string[];
  /** Street to turn onto, shown as-is; absent when unnamed or not a turn. */
  name?: string;
}

function knownTurn(turn: string | undefined): string | null {
  return turn !== undefined && turn in TURN_TEXT ? turn : null;
}

function turnText(t: Translate, turn: string): string {
  return t(`walk.turn.${turn.replace(/-/g, "_")}`, TURN_TEXT[turn]);
}

/**
 * The next step as separate, whole translated strings. Nothing is composed
 * inside a sentence: word order and case around a street name or a second
 * verb differ per language, and machine-translated fragments do not fit
 * together. The parts are shown side by side instead.
 */
export function walkStepParts(t: Translate, step: WalkingNextStep): WalkStepParts {
  const distance = t("unit.meters", "{n} m").replace("{n}", String(Math.round(step.distanceToStartMeters)));
  const turn = knownTurn(step.turn);
  const turned = turn !== null && turn !== "straight" ? turnText(t, turn) : null;
  switch (step.kind) {
    case "cross": {
      const cross = t("walk.step.cross", "Cross the street");
      return { distance, actions: turned ? [turned, cross] : [cross] };
    }
    case "stairs": {
      const stairs = t("walk.step.stairs", "Take the stairs");
      return { distance, actions: turned ? [turned, stairs] : [stairs] };
    }
    case "arrive":
      return { distance, actions: [t("walk.step.arrive", "Arrive")] };
    case "turn":
      return { distance, actions: [turnText(t, turn ?? "straight")], name: step.name || undefined };
  }
}

/** One line, as read aloud: "42 m · Turn left · Pylimo g." */
export function walkStepText(t: Translate, step: WalkingNextStep): string {
  const { distance, actions, name } = walkStepParts(t, step);
  return [distance, ...actions, ...(name ? [name] : [])].join(WALK_STEP_SEPARATOR);
}
