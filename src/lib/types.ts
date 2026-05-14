export type ApiFormat = "openai-chat-completions" | "anthropic-messages";

export type Settings = {
  apiFormat: ApiFormat;
  endpointUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  extraRequestParams: string;
  rubricPrompt: string;
  scoringPrompt: string;
};

export type SettingsConfig = Settings & {
  id: string;
  name: string;
  isActive: boolean;
  updatedAt: string;
};

export type Rubric = {
  id: string;
  name: string;
  description: string;
  evidenceHints: string[];
};

export type TaskStatus = "draft" | "queued" | "generating-rubrics" | "rubrics-ready" | "scoring" | "scored" | "error";
export type TaskMode = "auto" | "manual";

export type Task = {
  id: string;
  name: string;
  prompt: string;
  urls: string[];
  rubrics: Rubric[];
  rubricsSource: "user" | "generated" | "none";
  rubricsModified: boolean;
  qualityMode: boolean;
  qualityScoreText: string;
  qualityMatrix: number[][];
  mode: TaskMode;
  status: TaskStatus;
  error?: string;
  resultCount?: number;
  createdAt: string;
  updatedAt: string;
};

export type TaskLog = {
  id: string;
  taskId: string;
  message: string;
  extra?: unknown;
  createdAt: string;
};

export type SelectorRequirement = {
  ids: string[];
  classes: string[];
};

export type ElementEvidence = {
  selector: string;
  exists: boolean;
  visible: boolean;
  tag?: string;
  text?: string;
  className?: string;
  box?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

export type InteractionProbe = {
  name: string;
  passed: boolean;
  detail: string;
};

export type EvidencePlanStep = {
  rubricId: string;
  action:
    | "scanText"
    | "checkLinks"
    | "checkControls"
    | "checkIframe"
    | "readLocalStorage"
    | "click"
    | "hover"
    | "fill"
    | "press"
    | "drag"
    | "reload"
    | "setViewport"
    | "compareState";
  targetHints: string[];
  value?: string;
  key?: string;
  repeat?: number;
  note?: string;
};

export type EvidencePlanResult = EvidencePlanStep & {
  passed: boolean;
  detail: string;
};

export type RubricEvidence = {
  rubricId: string;
  rubric: string;
  keywords: string[];
  textMatches: string[];
  controls: Array<{
    tag: string;
    id: string;
    className: string;
    text: string;
    type?: string | null;
    placeholder?: string | null;
    visible?: boolean;
  }>;
  elements: Array<{
    tag: string;
    id: string;
    className: string;
    text: string;
    role?: string | null;
  }>;
  technologyMatches: string[];
  relatedInteractions: InteractionProbe[];
  plannedChecks: EvidencePlanResult[];
};

export type PageEvidence = {
  url: string;
  finalUrl: string;
  title: string;
  htmlSample: string;
  visibleText: string;
  screenshotPath?: string;
  requirements: SelectorRequirement;
  requiredElements: ElementEvidence[];
  importantElements: Array<{
    tag: string;
    id: string;
    className: string;
    text: string;
    role?: string | null;
  }>;
  controls: Array<{
    tag: string;
    id: string;
    className: string;
    text: string;
    type?: string | null;
    placeholder?: string | null;
    visible?: boolean;
  }>;
  layout: Record<string, unknown>;
  visual: Record<string, unknown>;
  technology: Record<string, unknown>;
  responsive: Record<string, unknown>;
  motion: Record<string, unknown>;
  interactions: InteractionProbe[];
  rubricEvidence: RubricEvidence[];
  errors: string[];
};

export type ScoreResult = {
  id: string;
  taskId: string;
  url: string;
  scores: number[];
  reasons: string[];
  evidence: PageEvidence;
  rawResponse: string;
  createdAt: string;
};
