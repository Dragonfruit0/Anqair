/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

export interface Artifact {
  id: string;
  styleName: string;
  html: string;
  status: 'streaming' | 'complete' | 'error';
}

export interface Session {
    id: string;
    prompt: string;
    userAnswers?: Record<string, string>; // Store the personalization answers
    timestamp: number;
    artifacts: Artifact[];
}

export interface RefinementQuestion {
    id: string;
    text: string;
    options: string[];
}

export interface ComponentVariation { name: string; html: string; }
export interface LayoutOption { name: string; css: string; previewHtml: string; }