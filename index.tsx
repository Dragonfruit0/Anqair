/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import { GoogleGenAI } from '@google/genai';
import React, { useState, useCallback, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom/client';

import { Artifact, Session, ComponentVariation, RefinementQuestion } from './types';
import { INITIAL_PLACEHOLDERS } from './constants';
import { generateId } from './utils';

import DottedGlowBackground from './components/DottedGlowBackground';
import ArtifactCard from './components/ArtifactCard';
import SideDrawer from './components/SideDrawer';
import { 
    ThinkingIcon, 
    CodeIcon, 
    SparklesIcon, 
    ArrowLeftIcon, 
    ArrowRightIcon, 
    ArrowUpIcon, 
    GridIcon 
} from './components/Icons';

const STYLE_PRESETS = [
    "Holographic 3D",
    "SaaS Minimal",
    "Cyberpunk",
    "Neubrutalist",
    "Glassmorphism",
    "Apple-Style"
];

function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSessionIndex, setCurrentSessionIndex] = useState<number>(-1);
  const [focusedArtifactIndex, setFocusedArtifactIndex] = useState<number | null>(null);
  
  const [inputValue, setInputValue] = useState<string>('');
  const [selectedStyles, setSelectedStyles] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string>('');
  
  // Questionnaire State
  const [refinementQuestions, setRefinementQuestions] = useState<RefinementQuestion[] | null>(null);
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [userAnswers, setUserAnswers] = useState<Record<string, string>>({});

  const [placeholderIndex, setPlaceholderIndex] = useState(0);
  const [placeholders, setPlaceholders] = useState<string[]>(INITIAL_PLACEHOLDERS);
  
  const [drawerState, setDrawerState] = useState<{
      isOpen: boolean;
      mode: 'code' | 'variations' | null;
      title: string;
      data: any; 
  }>({ isOpen: false, mode: null, title: '', data: null });

  const [componentVariations, setComponentVariations] = useState<ComponentVariation[]>([]);

  const inputRef = useRef<HTMLInputElement>(null);
  const gridScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
      inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (focusedArtifactIndex !== null && window.innerWidth <= 1024) {
        if (gridScrollRef.current) gridScrollRef.current.scrollTop = 0;
        window.scrollTo(0, 0);
    }
  }, [focusedArtifactIndex]);

  useEffect(() => {
      const interval = setInterval(() => {
          setPlaceholderIndex(prev => (prev + 1) % placeholders.length);
      }, 3000);
      return () => clearInterval(interval);
  }, [placeholders.length]);

  const handleInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(event.target.value);
  };

  const toggleStyle = (style: string) => {
      setSelectedStyles(prev => 
          prev.includes(style) ? prev.filter(s => s !== style) : [...prev, style]
      );
  };

  // Helper to parse JSON from AI response even if it includes markdown
  const extractJson = (text: string) => {
      try {
          // Attempt raw parse
          return JSON.parse(text);
      } catch (e) {
          // Attempt to find markdown JSON block
          const match = text.match(/```json([\s\S]*?)```/) || text.match(/\[([\s\S]*)\]/);
          if (match) {
              try { return JSON.parse(match[1] || match[0]); } catch (e2) { return null; }
          }
          return null;
      }
  };

  const parseJsonStream = async function* (responseStream: AsyncGenerator<{ text: string }>) {
      let buffer = '';
      for await (const chunk of responseStream) {
          const text = chunk.text;
          if (typeof text !== 'string') continue;
          buffer += text;
          let braceCount = 0;
          let start = buffer.indexOf('{');
          while (start !== -1) {
              braceCount = 0;
              let end = -1;
              for (let i = start; i < buffer.length; i++) {
                  if (buffer[i] === '{') braceCount++;
                  else if (buffer[i] === '}') braceCount--;
                  if (braceCount === 0 && i > start) {
                      end = i;
                      break;
                  }
              }
              if (end !== -1) {
                  const jsonString = buffer.substring(start, end + 1);
                  try {
                      yield JSON.parse(jsonString);
                      buffer = buffer.substring(end + 1);
                      start = buffer.indexOf('{');
                  } catch (e) {
                      start = buffer.indexOf('{', start + 1);
                  }
              } else {
                  break; 
              }
          }
      }
  };

  // Step 1: User hits enter -> We get questions
  const handleInitialSubmit = async (manualPrompt?: string) => {
      const promptToUse = manualPrompt || inputValue;
      const trimmedInput = promptToUse.trim();
      
      if (!trimmedInput || isLoading) return;
      if (!manualPrompt) setInputValue('');

      setIsLoading(true);
      setStatusMessage("Analyzing requirements...");
      setPendingPrompt(trimmedInput);

      try {
          const apiKey = process.env.API_KEY;
          if (!apiKey) throw new Error("API_KEY is not configured.");
          const ai = new GoogleGenAI({ apiKey });

          const qPrompt = `
You are a senior Product Manager. The user wants: "${trimmedInput}".
Contextual Tags: ${selectedStyles.join(', ')}.

Generate 3 SHORT, specific, multiple-choice questions to clarify the design goals (e.g., Target Audience, Vibe, Specific Functionality).
Return ONLY a raw JSON array:
[
  { "id": "q1", "text": "Question?", "options": ["Opt A", "Opt B", "Opt C"] }
]
          `.trim();

          const response = await ai.models.generateContent({
              model: 'gemini-3-flash-preview',
              contents: { role: 'user', parts: [{ text: qPrompt }] }
          });

          const questions = extractJson(response.text || '[]');
          
          if (Array.isArray(questions) && questions.length > 0) {
              setRefinementQuestions(questions);
              setUserAnswers({});
              setIsLoading(false);
          } else {
              // Fallback if no questions generated: go straight to generation
              startGeneration(trimmedInput, {});
          }

      } catch (e) {
          console.error("Analysis failed, skipping to generation", e);
          startGeneration(trimmedInput, {});
      }
  };

  const handleAnswerSelect = (questionId: string, answer: string) => {
      setUserAnswers(prev => ({...prev, [questionId]: answer}));
  };

  // Step 2: User answers questions (or skips) -> We generate UI
  const handleFinalizeGeneration = () => {
      if (pendingPrompt) {
          setRefinementQuestions(null);
          startGeneration(pendingPrompt, userAnswers);
      }
  };

  const startGeneration = useCallback(async (basePrompt: string, answers: Record<string, string>) => {
    setIsLoading(true);
    setStatusMessage("Architecting solution...");
    
    const baseTime = Date.now();
    const sessionId = generateId();

    const placeholderArtifacts: Artifact[] = Array(3).fill(null).map((_, i) => ({
        id: `${sessionId}_${i}`,
        styleName: 'Designing...',
        html: '',
        status: 'streaming',
    }));

    const newSession: Session = {
        id: sessionId,
        prompt: basePrompt,
        userAnswers: answers,
        timestamp: baseTime,
        artifacts: placeholderArtifacts
    };

    setSessions(prev => [...prev, newSession]);
    setCurrentSessionIndex(sessions.length); 
    setFocusedArtifactIndex(null); 

    try {
        const apiKey = process.env.API_KEY;
        if (!apiKey) throw new Error("API_KEY is not configured.");
        const ai = new GoogleGenAI({ apiKey });

        // Construct a rich context string from answers and tags
        const answersStr = Object.entries(answers).map(([k, v]) => `- Preference: ${v}`).join('\n');
        const tagsStr = selectedStyles.length > 0 ? `Styles: ${selectedStyles.join(', ')}` : '';
        
        const fullContext = `
User Request: "${basePrompt}"
${tagsStr}
${answersStr}
        `.trim();

        const stylePrompt = `
Generate 3 distinct, high-end visual directions for a web interface based on this context:
${fullContext}

**REQUIREMENTS:**
- Directions must be HIGHLY diverse (e.g. one Minimal, one 3D/Spatial, one Complex/Data-heavy).
- If the user asked for "3D" or "Futuristic", ensure at least 2 directions are heavily stylized.
- Return ONLY a raw JSON array of strings: ["Direction Name 1", "Direction Name 2", "Direction Name 3"].
        `.trim();

        const styleResponse = await ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: { role: 'user', parts: [{ text: stylePrompt }] }
        });

        let generatedStyles: string[] = extractJson(styleResponse.text || '[]') || [];
        if (generatedStyles.length < 3) generatedStyles = ["Modern Clean", "Futuristic Dark", "Spatial Depth"];
        generatedStyles = generatedStyles.slice(0, 3);

        setSessions(prev => prev.map(s => {
            if (s.id !== sessionId) return s;
            return {
                ...s,
                artifacts: s.artifacts.map((art, i) => ({ ...art, styleName: generatedStyles[i] }))
            };
        }));

        const generateArtifact = async (artifact: Artifact, styleInstruction: string) => {
            try {
                const prompt = `
Act as a Lead Frontend Architect. Create a production-ready HTML/CSS component.

**CONTEXT:**
${fullContext}

**CHOSEN AESTHETIC:** ${styleInstruction}

**TECHNICAL MANDATES (Must Follow):**
1. **3D & Depth:** Use \`transform: perspective(1000px) rotateX(...)\`, \`box-shadow\`, and layering to create real depth if the style calls for it.
2. **Modern CSS:** Use \`:has()\`, \`backdrop-filter\`, \`mix-blend-mode\`, and CSS Grid.
3. **Interactivity:** deeply interactive \`:hover\` states. Things should scale, glow, or shift on hover.
4. **No External Libs:** Raw CSS/HTML only. No Tailwind. SVG icons allowed (inline).
5. **Images:** Use \`unsplash.com\` source URLs for placeholders if needed.
6. **Responsiveness:** Must work on mobile and desktop.

**OUTPUT:**
Return ONLY the raw HTML code.
          `.trim();
          
                const responseStream = await ai.models.generateContentStream({
                    model: 'gemini-3-flash-preview',
                    contents: [{ parts: [{ text: prompt }], role: "user" }],
                });

                let accumulatedHtml = '';
                for await (const chunk of responseStream) {
                    const text = chunk.text;
                    if (typeof text === 'string') {
                        accumulatedHtml += text;
                        setSessions(prev => prev.map(sess => 
                            sess.id === sessionId ? {
                                ...sess,
                                artifacts: sess.artifacts.map(art => 
                                    art.id === artifact.id ? { ...art, html: accumulatedHtml } : art
                                )
                            } : sess
                        ));
                    }
                }
                
                let finalHtml = accumulatedHtml.trim();
                // Basic cleanup
                if (finalHtml.startsWith('```html')) finalHtml = finalHtml.substring(7).trimStart();
                if (finalHtml.startsWith('```')) finalHtml = finalHtml.substring(3).trimStart();
                if (finalHtml.endsWith('```')) finalHtml = finalHtml.substring(0, finalHtml.length - 3).trimEnd();

                setSessions(prev => prev.map(sess => 
                    sess.id === sessionId ? {
                        ...sess,
                        artifacts: sess.artifacts.map(art => 
                            art.id === artifact.id ? { ...art, html: finalHtml, status: finalHtml ? 'complete' : 'error' } : art
                        )
                    } : sess
                ));

            } catch (e: any) {
                setSessions(prev => prev.map(sess => 
                    sess.id === sessionId ? {
                        ...sess,
                        artifacts: sess.artifacts.map(art => 
                            art.id === artifact.id ? { ...art, html: `<div style="padding:20px; color:red">Generation Failed</div>`, status: 'error' } : art
                        )
                    } : sess
                ));
            }
        };

        await Promise.all(placeholderArtifacts.map((art, i) => generateArtifact(art, generatedStyles[i])));

    } catch (e) {
        console.error("Generation error", e);
    } finally {
        setIsLoading(false);
        setStatusMessage('');
        setPendingPrompt(null);
    }
  }, [selectedStyles]);

  const handleSurpriseMe = () => {
      const currentPrompt = placeholders[placeholderIndex];
      setInputValue(currentPrompt);
      handleInitialSubmit(currentPrompt);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && !isLoading) {
      event.preventDefault();
      handleInitialSubmit();
    } else if (event.key === 'Tab' && !inputValue && !isLoading) {
        event.preventDefault();
        setInputValue(placeholders[placeholderIndex]);
    }
  };

  // ... (Keep existing navigation logic: nextItem, prevItem, etc.)
  const nextItem = useCallback(() => {
      if (focusedArtifactIndex !== null) {
          if (focusedArtifactIndex < 2) setFocusedArtifactIndex(focusedArtifactIndex + 1);
      } else {
          if (currentSessionIndex < sessions.length - 1) setCurrentSessionIndex(currentSessionIndex + 1);
      }
  }, [currentSessionIndex, sessions.length, focusedArtifactIndex]);

  const prevItem = useCallback(() => {
      if (focusedArtifactIndex !== null) {
          if (focusedArtifactIndex > 0) setFocusedArtifactIndex(focusedArtifactIndex - 1);
      } else {
           if (currentSessionIndex > 0) setCurrentSessionIndex(currentSessionIndex - 1);
      }
  }, [currentSessionIndex, focusedArtifactIndex]);

  const handleGenerateVariations = useCallback(async () => {
      // Re-use logic but update prompt to be more specific based on new constraints
      const currentSession = sessions[currentSessionIndex];
      if (!currentSession || focusedArtifactIndex === null) return;
      const currentArtifact = currentSession.artifacts[focusedArtifactIndex];

      setIsLoading(true);
      setComponentVariations([]);
      setDrawerState({ isOpen: true, mode: 'variations', title: 'Smart Variations', data: currentArtifact.id });

      try {
          const apiKey = process.env.API_KEY;
          if (!apiKey) throw new Error("API_KEY");
          const ai = new GoogleGenAI({ apiKey });
          
          const prompt = `
  You are an expert UI Engineer. Create 3 Variations of the provided component.
  Original Prompt: "${currentSession.prompt}"
  Context: ${JSON.stringify(currentSession.userAnswers)}
  
  Variation 1: "Dark/Light Mode Flip" (Invert colors, adjust shadows).
  Variation 2: "Structural Shift" (Change layout from Grid to Flex or Sidebar to Topbar).
  Variation 3: "Motion & Depth" (Add parallax, 3D tilts, and complex hover effects).
  
  Output JSON Stream: { "name": "...", "html": "..." }
          `.trim();
  
          const responseStream = await ai.models.generateContentStream({
              model: 'gemini-3-flash-preview',
               contents: [{ parts: [{ text: prompt }], role: 'user' }],
               config: { temperature: 1.1 }
          });
  
          for await (const variation of parseJsonStream(responseStream)) {
              if (variation.name && variation.html) {
                  setComponentVariations(prev => [...prev, variation]);
              }
          }
      } catch (e) {
          console.error(e);
      } finally {
          setIsLoading(false);
      }
  }, [sessions, currentSessionIndex, focusedArtifactIndex]);

  const applyVariation = (html: string) => {
      if (focusedArtifactIndex === null) return;
      setSessions(prev => prev.map((sess, i) => 
          i === currentSessionIndex ? {
              ...sess,
              artifacts: sess.artifacts.map((art, j) => 
                j === focusedArtifactIndex ? { ...art, html, status: 'complete' } : art
              )
          } : sess
      ));
      setDrawerState(s => ({ ...s, isOpen: false }));
  };

  const handleShowCode = () => {
    const currentSession = sessions[currentSessionIndex];
    if (currentSession && focusedArtifactIndex !== null) {
        const artifact = currentSession.artifacts[focusedArtifactIndex];
        setDrawerState({ isOpen: true, mode: 'code', title: 'Source Code', data: artifact.html });
    }
  };

  const hasStarted = sessions.length > 0 || isLoading;
  const currentSession = sessions[currentSessionIndex];

  let canGoBack = false;
  let canGoForward = false;
  if (hasStarted) {
      if (focusedArtifactIndex !== null) {
          canGoBack = focusedArtifactIndex > 0;
          canGoForward = focusedArtifactIndex < (currentSession?.artifacts.length || 0) - 1;
      } else {
          canGoBack = currentSessionIndex > 0;
          canGoForward = currentSessionIndex < sessions.length - 1;
      }
  }

  return (
    <>
        <SideDrawer 
            isOpen={drawerState.isOpen} 
            onClose={() => setDrawerState(s => ({...s, isOpen: false}))} 
            title={drawerState.title}
        >
            {isLoading && drawerState.mode === 'variations' && componentVariations.length === 0 && (
                 <div className="loading-state"><ThinkingIcon /> Designing variations...</div>
            )}
            {drawerState.mode === 'code' && <pre className="code-block"><code>{drawerState.data}</code></pre>}
            {drawerState.mode === 'variations' && (
                <div className="sexy-grid">
                    {componentVariations.map((v, i) => (
                         <div key={i} className="sexy-card" onClick={() => applyVariation(v.html)}>
                             <div className="sexy-preview">
                                 <iframe srcDoc={v.html} title={v.name} sandbox="allow-scripts allow-same-origin" />
                             </div>
                             <div className="sexy-label">{v.name}</div>
                         </div>
                    ))}
                </div>
            )}
        </SideDrawer>

        {/* Refinement / Questionnaire Overlay */}
        {refinementQuestions && (
            <div className="refinement-overlay">
                <div className="refinement-modal">
                    <div className="refinement-header">
                        <h2>Personalize Result</h2>
                        <p>Customize the output for "{pendingPrompt}"</p>
                    </div>
                    <div className="refinement-body">
                        {refinementQuestions.map((q) => (
                            <div key={q.id} className="question-group">
                                <label>{q.text}</label>
                                <div className="options-row">
                                    {q.options.map(opt => (
                                        <button 
                                            key={opt}
                                            className={`option-chip ${userAnswers[q.id] === opt ? 'selected' : ''}`}
                                            onClick={() => handleAnswerSelect(q.id, opt)}
                                        >
                                            {opt}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                    <div className="refinement-footer">
                        <button className="skip-btn" onClick={handleFinalizeGeneration}>Skip & Generate</button>
                        <button className="generate-btn" onClick={handleFinalizeGeneration}>
                            <SparklesIcon /> Generate UI
                        </button>
                    </div>
                </div>
            </div>
        )}

        <div className="immersive-app">
            <DottedGlowBackground gap={24} radius={1.5} color="rgba(255, 255, 255, 0.02)" glowColor="rgba(255, 255, 255, 0.15)" speedScale={0.5} />

            <div className={`stage-container ${focusedArtifactIndex !== null ? 'mode-focus' : 'mode-split'}`}>
                 <div className={`empty-state ${hasStarted ? 'fade-out' : ''}`}>
                     <div className="empty-content">
                         <h1>Anqair</h1>
                         <p>Professional SaaS Component Builder</p>
                         <button className="surprise-button" onClick={handleSurpriseMe} disabled={isLoading}>
                             <SparklesIcon /> Surprise Me
                         </button>
                     </div>
                 </div>

                {sessions.map((session, sIndex) => {
                    let positionClass = 'hidden';
                    if (sIndex === currentSessionIndex) positionClass = 'active-session';
                    else if (sIndex < currentSessionIndex) positionClass = 'past-session';
                    else if (sIndex > currentSessionIndex) positionClass = 'future-session';
                    
                    return (
                        <div key={session.id} className={`session-group ${positionClass}`}>
                            <div className="artifact-grid" ref={sIndex === currentSessionIndex ? gridScrollRef : null}>
                                {session.artifacts.map((artifact, aIndex) => (
                                    <ArtifactCard 
                                        key={artifact.id}
                                        artifact={artifact}
                                        isFocused={focusedArtifactIndex === aIndex}
                                        onClick={() => setFocusedArtifactIndex(aIndex)}
                                    />
                                ))}
                            </div>
                        </div>
                    );
                })}
            </div>

            {canGoBack && <button className="nav-handle left" onClick={prevItem}><ArrowLeftIcon /></button>}
            {canGoForward && <button className="nav-handle right" onClick={nextItem}><ArrowRightIcon /></button>}

            <div className={`action-bar ${focusedArtifactIndex !== null ? 'visible' : ''}`}>
                 <div className="active-prompt-label">
                    {currentSession?.prompt}
                 </div>
                 <div className="action-buttons">
                    <button onClick={() => setFocusedArtifactIndex(null)}><GridIcon /> Grid View</button>
                    <button onClick={handleGenerateVariations} disabled={isLoading}><SparklesIcon /> Variations</button>
                    <button onClick={handleShowCode}><CodeIcon /> Source</button>
                 </div>
            </div>

            <div className={`bottom-controls-container ${isLoading || refinementQuestions ? 'disabled' : ''}`}>
                <div className="style-pills-row">
                    {STYLE_PRESETS.map(style => (
                        <button 
                            key={style} 
                            className={`style-pill ${selectedStyles.includes(style) ? 'active' : ''}`}
                            onClick={() => toggleStyle(style)}
                        >
                            {style}
                        </button>
                    ))}
                </div>

                <div className={`input-wrapper ${isLoading ? 'loading' : ''}`}>
                    {(!inputValue && !isLoading) && (
                        <div className="animated-placeholder" key={placeholderIndex}>
                            <span className="placeholder-text">{placeholders[placeholderIndex]}</span>
                            <span className="tab-hint">Tab</span>
                        </div>
                    )}
                    {!isLoading ? (
                        <input 
                            ref={inputRef}
                            type="text" 
                            value={inputValue} 
                            onChange={handleInputChange} 
                            onKeyDown={handleKeyDown} 
                            disabled={isLoading} 
                        />
                    ) : (
                        <div className="input-generating-label">
                            <span className="generating-prompt-text">{statusMessage || currentSession?.prompt}</span>
                            <ThinkingIcon />
                        </div>
                    )}
                    <button className="send-button" onClick={() => handleInitialSubmit()} disabled={isLoading || !inputValue.trim()}>
                        <ArrowUpIcon />
                    </button>
                </div>
            </div>
        </div>
    </>
  );
}

const rootElement = document.getElementById('root');
if (rootElement) {
  const root = ReactDOM.createRoot(rootElement);
  root.render(<React.StrictMode><App /></React.StrictMode>);
}