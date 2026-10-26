export type ChunkType = "text" | "figure" | "table" | "footnotes" | "credit";

export interface ChunkLocation {
  part: string;
  sectionPath: string[];
  box: string | null;
  pdfPages: number[];
  pageLabels: string[];
}

export interface Parent extends ChunkLocation {
  id: string;
  text: string;
  tokens: number;
}

export interface Chunk extends ChunkLocation {
  id: string;
  parentId: string | null;
  type: ChunkType;
  elementIds: string[];
  exhibit: string | null;
  context: string;
  text: string;
  tokens: number;
}

export interface ChunkSet {
  source: string;
  options: ChunkOptions;
  parents: Parent[];
  chunks: Chunk[];
}

export interface ChunkOptions {
  targetTokens: number;
  maxTokens: number;
  minTokens: number;
  parentMaxTokens: number;
}
