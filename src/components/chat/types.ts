/** Shapes shared by the desk, the answer body and the evidence panel. */

export interface Source {
  ticker: string;
  fiscalYear: string;
  section: string;
  sourceUrl: string;
  score: number;
  /** The retrieved text. Absent on answers saved before passages were stored. */
  passages?: string[];
}

export interface ChatMessage {
  id?: string;
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  topCosine?: number;
  gated?: boolean;
  degraded?: boolean;
  notice?: string;
  latencyMs?: number;
}

export interface CorpusItem {
  ticker: string;
  name: string;
  fiscalYear: string;
}

/** Which passage the evidence panel is showing, and why. */
export interface EvidenceFocus {
  messageIndex: number;
  sourceIndex: number;
  /** The sentence in the answer whose citation was clicked, if any. */
  claim: string | null;
}
