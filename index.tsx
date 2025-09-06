/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleGenAI, Modality, Type} from '@google/genai';
import {marked} from 'marked';

// --- Interfaces ---
interface SlideData {
  lyrics: string;
  imageSrc: string;
}

interface SongSlide {
  lyrics: string;
  image_prompt: string;
}

interface SongStructure {
  slides: SongSlide[];
  music_style: string;
}

interface TikTok {
  id: string;
  slides: SlideData[];
  character: string;
  prompt: string;
  songSrc: string | null; // Null if using browser TTS
  instrumentalSrc: string | null; // For ElevenLabs instrumental
  instrumentalId: string | null; // For browser TTS fallback beats
  useBrowserTTS: boolean;
  voiceName?: string; // For browser TTS
  element?: HTMLElement;
}

// --- DOM Elements ---
let ai: GoogleGenAI;
const userInput = document.querySelector('#input') as HTMLTextAreaElement;
const slideshow = document.querySelector('#slideshow') as HTMLDivElement;
const error = document.querySelector('#error') as HTMLDivElement;
const characterInput = document.querySelector(
  '#character-input',
) as HTMLInputElement;
const voiceSelector = document.querySelector(
  '#voice-selector',
) as HTMLSelectElement;
const examplesSelector = document.querySelector(
  '#examples-selector',
) as HTMLSelectElement;
const initialMessage = document.querySelector(
  '#initial-message',
) as HTMLDivElement;
const generateBtn = document.querySelector('#generate-btn') as HTMLButtonElement;
const historyGallery = document.querySelector(
  '#history-gallery',
) as HTMLDivElement;
const themeToggle = document.querySelector('#theme-toggle') as HTMLButtonElement;

// Modal Elements
const modalOverlay = document.querySelector('#modal-overlay') as HTMLDivElement;
const apiKeyModal = document.querySelector('#api-key-modal') as HTMLDivElement;
const geminiApiKeyInput = document.querySelector(
  '#gemini-api-key',
) as HTMLInputElement;
const elevenLabsApiKeyInput = document.querySelector(
  '#elevenlabs-api-key',
) as HTMLInputElement;
const saveApiKeysBtn = document.querySelector(
  '#save-api-keys-btn',
) as HTMLButtonElement;
const closeApiKeyModalBtn = document.querySelector(
  '#close-api-key-modal-btn',
) as HTMLButtonElement;
const addApiBtn = document.querySelector('#add-api-btn') as HTMLButtonElement;
const errorModal = document.querySelector('#error-modal') as HTMLDivElement;
const errorModalMessage = document.querySelector(
  '#error-modal-message',
) as HTMLParagraphElement;
const closeErrorModalBtn = document.querySelector(
  '#close-error-modal-btn',
) as HTMLButtonElement;
const geminiFormGroup = document.querySelector(
  '#gemini-form-group',
) as HTMLDivElement;
const elevenLabsFormGroup = document.querySelector(
  '#elevenlabs-form-group',
) as HTMLDivElement;
const apiModalMessage = document.querySelector(
  '#api-modal-message',
) as HTMLParagraphElement;

// --- State Management ---
let isPlaying = false;
let isGenerating = false;
let savedTikToks: TikTok[] = [];
let tiktokObserver: IntersectionObserver;
let slideObserver: IntersectionObserver | null = null;
let activeTikTokContainer: HTMLElement | null = null;
let currentAudio: HTMLAudioElement | null = null;
let currentInstrumentalAudio: HTMLAudioElement | null = null;
let geminiApiKey: string | null = null;
let elevenLabsApiKey: string | null = null;

// --- Database Management ---
const DB_NAME = 'TikTokForLearningDB';
const DB_VERSION = 1;
const STORE_NAME = 'tiktoks';
let db: IDBDatabase;

// --- Initialization ---
init();

async function init() {
  try {
    await initDB();
    loadApiKeys();
    initializeGenAI();
    await loadHistoryFromDB();
    setupEventListeners();
    setupTikTokObserver();
    setupTheme();
    populateVoices(); // Populate voices initially
    speechSynthesis.onvoiceschanged = populateVoices; // and when they load
  } catch (e) {
    console.error('Initialization failed:', e);
    showErrorPopup('Application failed to start. Could not access storage.');
  }
}

// --- Data Persistence (IndexedDB) ---

function initDB(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const dbInstance = request.result;
      if (!dbInstance.objectStoreNames.contains(STORE_NAME)) {
        dbInstance.createObjectStore(STORE_NAME, {keyPath: 'id'});
      }
    };

    request.onsuccess = () => {
      db = request.result;
      resolve();
    };

    request.onerror = () => {
      console.error('IndexedDB error:', request.error);
      reject(new Error('Failed to open IndexedDB.'));
    };
  });
}

function saveTikTokToDB(tiktok: TikTok): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!db) {
      reject(new Error('Database is not initialized.'));
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const {element, ...savableTikTok} = tiktok;
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.put(savableTikTok);

    request.onsuccess = () => resolve();
    request.onerror = () => {
      console.error('Failed to save TikTok to DB:', request.error);
      reject(request.error);
    };
  });
}

async function loadHistoryFromDB() {
  if (!db) {
    console.error('Database is not initialized.');
    return;
  }
  const transaction = db.transaction(STORE_NAME, 'readonly');
  const store = transaction.objectStore(STORE_NAME);
  const request = store.getAll();

  return new Promise<void>((resolve, reject) => {
    request.onsuccess = () => {
      const loadedTikToks = request.result as TikTok[];
      // Sort by ID (timestamp) descending to get newest first
      loadedTikToks.sort((a, b) => Number(b.id) - Number(a.id));
      savedTikToks = loadedTikToks;

      if (savedTikToks.length > 0) {
        initialMessage.setAttribute('hidden', 'true');
        slideshow.removeAttribute('hidden');
        // Add to feed in reverse order of the now newest-first array,
        // so that prepend() correctly places the newest item at the top.
        [...savedTikToks].reverse().forEach(addTikTokToFeed);
        renderHistoryGallery();
      }
      resolve();
    };
    request.onerror = () => {
      console.error('Failed to load history from DB:', request.error);
      reject(request.error);
    };
  });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// --- API Key Management ---

function loadApiKeys() {
  geminiApiKey = localStorage.getItem('GEMINI_API_KEY');
  elevenLabsApiKey = localStorage.getItem('ELEVENLABS_API_KEY');
  if (geminiApiKey) geminiApiKeyInput.value = geminiApiKey;
  if (elevenLabsApiKey) elevenLabsApiKeyInput.value = elevenLabsApiKey;
}

function saveApiKeys() {
  const geminiKey = geminiApiKeyInput.value.trim();
  const elevenLabsKey = elevenLabsApiKeyInput.value.trim();

  if (geminiKey) {
    localStorage.setItem('GEMINI_API_KEY', geminiKey);
    geminiApiKey = geminiKey;
    initializeGenAI(); // Re-initialize with the new key
  }
  if (elevenLabsKey) {
    localStorage.setItem('ELEVENLABS_API_KEY', elevenLabsKey);
    elevenLabsApiKey = elevenLabsKey;
  }
  toggleApiKeyModal(false);
}

function initializeGenAI() {
  if (geminiApiKey) {
    try {
      ai = new GoogleGenAI({apiKey: geminiApiKey});
    } catch (e) {
      ai = undefined;
      showErrorPopup(`Failed to initialize Gemini Client: ${String(e)}`);
    }
  } else {
    ai = undefined;
  }
}

// --- UI & Voice Population ---
function populateVoices() {
  const voices = speechSynthesis.getVoices();
  const voiceGroup = document.querySelector(
    '#browser-voices-group',
  ) as HTMLOptGroupElement;
  if (!voiceGroup) return;

  voiceGroup.innerHTML = ''; // Clear existing voices
  voices
    .filter((voice) => voice.lang.startsWith('en')) // Filter for English voices
    .forEach((voice) => {
      const option = document.createElement('option');
      option.value = voice.name;
      option.textContent = `${voice.name} (${voice.lang})`;
      voiceGroup.appendChild(option);
    });
}

// --- Modal Controls ---
function toggleApiKeyModal(show: boolean) {
  modalOverlay.classList.toggle('hidden', !show);
  apiKeyModal.classList.toggle('hidden', !show);
}

function showApiKeyModalWithContext(
  requireGemini: boolean,
  requireElevenLabs: boolean,
) {
  let message = 'Please enter your ';
  const missingKeys = [];

  geminiFormGroup.classList.toggle('hidden', !requireGemini);
  if (requireGemini) {
    missingKeys.push('Gemini API Key');
  }

  elevenLabsFormGroup.classList.toggle('hidden', !requireElevenLabs);
  if (requireElevenLabs) {
    missingKeys.push('ElevenLabs API Key');
  }

  message += missingKeys.join(' and ');
  message += ' to proceed.';

  apiModalMessage.textContent = message;

  toggleApiKeyModal(true);
}

function showErrorPopup(message: string) {
  errorModalMessage.textContent = message;
  modalOverlay.classList.remove('hidden');
  errorModal.classList.remove('hidden');
}

function closeErrorPopup() {
  modalOverlay.classList.add('hidden');
  errorModal.classList.add('hidden');
}

// --- Core Generation Functions ---

function selectBeatForStyle(style: string): string {
  const lowerStyle = style.toLowerCase();
  if (
    lowerStyle.includes('upbeat') ||
    lowerStyle.includes('pop') ||
    lowerStyle.includes('happy') ||
    lowerStyle.includes('rock')
  ) {
    return 'beat-upbeat';
  } else if (
    lowerStyle.includes('ballad') ||
    lowerStyle.includes('gentle') ||
    lowerStyle.includes('slow') ||
    lowerStyle.includes('acoustic')
  ) {
    return 'beat-ballad';
  } else if (
    lowerStyle.includes('epic') ||
    lowerStyle.includes('cinematic') ||
    lowerStyle.includes('score')
  ) {
    return 'beat-epic';
  }
  return 'beat-upbeat'; // Default fallback
}

async function generateInstrumentalMusic(style: string): Promise<string> {
  if (!elevenLabsApiKey) {
    throw new Error('ElevenLabs API key is not set.');
  }
  const response = await fetch(
    'https://api.elevenlabs.io/v1/sound-generation',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': elevenLabsApiKey,
      },
      body: JSON.stringify({
        text: style,
        duration_seconds: 22, // Create a loopable track
        prompt_influence: 0.7,
      }),
    },
  );
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ElevenLabs Music API error: ${errorText}`);
  }
  const audioBlob = await response.blob();
  return blobToBase64(audioBlob);
}

async function generateAudioFromText(text: string): Promise<string> {
  if (!elevenLabsApiKey) {
    throw new Error('ElevenLabs API key is not set.');
  }
  // A good voice for singing and storytelling.
  const VOICE_ID = '21m00Tcm4TlvDq8ikWAM';
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': elevenLabsApiKey,
      },
      body: JSON.stringify({
        text: text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.5,
          use_speaker_boost: true,
        },
      }),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    const errorJson = JSON.parse(errorText);
    if (errorJson?.detail?.status === 'invalid_api_key') {
      throw new Error('invalid_api_key');
    }
    throw new Error(`ElevenLabs TTS API error: ${errorText}`);
  }

  const audioBlob = await response.blob();
  return blobToBase64(audioBlob);
}

async function generateImageFromPrompt(prompt: string): Promise<string> {
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash-image-preview',
    contents: {
      parts: [{text: `A 9:16 aspect ratio image of: ${prompt}`}],
    },
    config: {
      responseModalities: [Modality.IMAGE, Modality.TEXT],
    },
  });

  for (const part of response.candidates[0].content.parts) {
    if (part.inlineData && part.inlineData.data) {
      const base64ImageBytes: string = part.inlineData.data;
      return `data:${part.inlineData.mimeType};base64,${base64ImageBytes}`;
    }
  }

  throw new Error('Image generation failed. The model did not return an image.');
}

function getInstructionsForSong(character: string): string {
  const baseInstructions = `
    You are a creative songwriter and visual artist.
    Your task is to create a short, catchy, and simple song that explains the user's query.
    The song must be from the perspective of the specified character.
    Generate a response in JSON format.
    The JSON object must contain two keys:
    1. "slides": An array of slide objects, where each slide contains a short line of "lyrics" and a corresponding descriptive "image_prompt" for an illustration to match that line.
    2. "music_style": A short string describing the musical style of the song (e.g., "upbeat pop", "gentle acoustic ballad", "epic cinematic score").
    Do NOT include any text, words, or letters in the image prompt itself.
    The song should have between 6 and 8 slides.
    No commentary, just the JSON object.`;

  const emojiRegex = /^\p{Emoji}\s*/u;
  const logicName = character.replace(emojiRegex, '').trim();
  const characterNameForPrompt =
    logicName.charAt(0).toUpperCase() + logicName.slice(1);

  let characterSpecifics = '';
  switch (logicName.toLowerCase()) {
    case 'spider-man':
      characterSpecifics =
        'Use concepts like web-slinging, spider-sense, and great responsibility in the lyrics.';
      break;
    case 'barbie':
      characterSpecifics =
        'Use themes of fashion, friendship, and her many careers in the lyrics.';
      break;
    case 'simba':
      characterSpecifics =
        'Use themes of the circle of life, the pride lands, and his jungle friends in the lyrics.';
      break;
    default:
      characterSpecifics = `Incorporate ${characterNameForPrompt}'s unique personality, skills, and famous concepts into the lyrics.`;
  }

  return `${baseInstructions} ${characterSpecifics}`;
}

async function generate() {
  const message = userInput.value.trim();
  const voiceChoice = voiceSelector.value;
  if (!message || isGenerating) return;

  // --- Intelligent API Key Check ---
  const isGeminiKeyMissing = !geminiApiKey;
  const isElevenLabsKeyNeeded = voiceChoice === 'elevenlabs';
  const isElevenLabsKeyMissing = isElevenLabsKeyNeeded && !elevenLabsApiKey;

  if (isGeminiKeyMissing || isElevenLabsKeyMissing) {
    showApiKeyModalWithContext(isGeminiKeyMissing, isElevenLabsKeyMissing);
    return;
  }

  if (!ai) {
    showErrorPopup(
      'The Gemini client is not initialized. Please check your API key.',
    );
    toggleApiKeyModal(true);
    return;
  }

  isGenerating = true;
  generateBtn.disabled = true;
  generateBtn.textContent = 'Generating...';
  stopSlideshow();

  error.innerHTML = '';
  error.toggleAttribute('hidden', true);
  initialMessage.setAttribute('hidden', 'true');
  slideshow.removeAttribute('hidden');

  try {
    const finalCharacter = characterInput.value.trim();
    if (!finalCharacter) {
      showErrorPopup('Please enter or select a narrator.');
      return;
    }

    const instructions = getInstructionsForSong(finalCharacter);

    const result = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: `${message}\n${instructions}`,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            slides: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  lyrics: {type: Type.STRING},
                  image_prompt: {type: Type.STRING},
                },
              },
            },
            music_style: {type: Type.STRING},
          },
        },
      },
    });

    const songData = JSON.parse(result.text) as SongStructure;
    if (!songData || !songData.slides || songData.slides.length === 0) {
      throw new Error('Could not generate song structure from model.');
    }
    const songStructure = songData.slides;
    const musicStyle = songData.music_style || 'a catchy song';
    const allLyricsText = songStructure.map((s) => s.lyrics).join('\n');
    const imagePrompts = songStructure.map((s) => s.image_prompt);

    let songSrc: string | null = null;
    let instrumentalSrc: string | null = null;
    let instrumentalId: string | null = null;
    let useBrowserTTS = false;
    let images: string[] = [];

    // --- Audio Generation Step ---
    if (voiceChoice === 'elevenlabs') {
      try {
        const [vocalSrc, instrumental] = await Promise.all([
          generateAudioFromText(allLyricsText),
          generateInstrumentalMusic(musicStyle),
        ]);
        songSrc = vocalSrc;
        instrumentalSrc = instrumental;
      } catch (elevenLabsError) {
        if (String(elevenLabsError).includes('invalid_api_key')) {
          throw elevenLabsError; // Re-throw to be caught by the main try-catch
        }
        showErrorPopup(
          `ElevenLabs failed to generate audio: ${String(elevenLabsError)}. Please try again or switch to the 'Browser Voice' narrator.`,
        );
        return; // Stop generation
      }
    } else {
      useBrowserTTS = true;
      instrumentalId = selectBeatForStyle(musicStyle);
    }

    // --- Image Generation Step ---
    try {
      images = await Promise.all(
        imagePrompts.map((prompt) => generateImageFromPrompt(prompt)),
      );
    } catch (imageError) {
      showErrorPopup(
        `Failed to generate images: ${String(imageError)}. Please try again.`,
      );
      return; // Stop generation
    }

    const newTikTok: TikTok = {
      id: Date.now().toString(),
      slides: songStructure.map((part, index) => ({
        lyrics: part.lyrics,
        imageSrc: images[index],
      })),
      character: finalCharacter,
      prompt: message,
      songSrc: songSrc,
      instrumentalSrc: instrumentalSrc,
      instrumentalId: instrumentalId,
      useBrowserTTS: useBrowserTTS,
      voiceName: useBrowserTTS ? voiceChoice : undefined,
    };

    if (newTikTok.slides.length > 0) {
      await saveAndRenderNewTikTok(newTikTok);
    } else {
      throw new Error('No content was generated. Please try again.');
    }
  } catch (e) {
    const msg = String(e);
    if (msg.includes('invalid_api_key')) {
      showErrorPopup(
        'Your ElevenLabs API key is invalid. Please click the "Add API" button in the top right to enter a valid key.',
      );
    } else {
      showErrorPopup(`Something went wrong: ${msg}`);
    }
    if (slideshow.children.length === 0) {
      slideshow.setAttribute('hidden', 'true');
      initialMessage.removeAttribute('hidden');
    }
  } finally {
    isGenerating = false;
    generateBtn.disabled = false;
    generateBtn.textContent = 'Generate TikTok';
    userInput.focus();
  }
}

// --- Rendering & DOM Manipulation ---

async function saveAndRenderNewTikTok(tiktok: TikTok) {
  try {
    // Add to the beginning of the in-memory array (newest-first)
    savedTikToks.unshift(tiktok);
    await saveTikTokToDB(tiktok);
    addTikTokToFeed(tiktok);
    renderHistoryGallery();
    // Scroll the main feed to the top to show the new video
    slideshow.scrollTo({top: 0, behavior: 'smooth'});
  } catch (e) {
    savedTikToks.shift(); // Remove from memory if save fails
    console.error('Failed to save TikTok:', e);
    showErrorPopup(
      'Failed to save your new TikTok. Storage might be full or corrupted.',
    );
  }
}

function addTikTokToFeed(tiktok: TikTok) {
  const tiktokContainer = document.createElement('div');
  tiktokContainer.className = 'tiktok-item-container';
  tiktokContainer.dataset.tiktokId = tiktok.id;

  const horizontalSlider = document.createElement('div');
  horizontalSlider.className = 'horizontal-slider';

  for (const slideData of tiktok.slides) {
    const slide = createSlideElement(
      slideData,
      tiktok.prompt,
      tiktok.character,
    );
    horizontalSlider.append(slide);
  }

  tiktokContainer.append(horizontalSlider);
  // Prepend to show the newest video at the top of the feed
  slideshow.prepend(tiktokContainer);
  tiktokObserver.observe(tiktokContainer);
  tiktok.element = tiktokContainer;
}

function createSlideElement(
  slideData: SlideData,
  prompt: string,
  character: string,
): HTMLDivElement {
  const slide = document.createElement('div');
  slide.className = 'slide';
  const characterName = character.charAt(0).toUpperCase() + character.slice(1);
  slide.innerHTML = `
    <img src="${slideData.imageSrc}" alt="Generated illustration">
    <div class="slide-content">
       <div class="slide-prompt">
        <span class="creator-name">${characterName}</span>
        ${prompt}
      </div>
      <div class="slide-answer">${marked.parse(slideData.lyrics)}</div>
    </div>
    <div class="slide-actions">
      <button class="action-icon like-btn"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg><span>Like</span></button>
      <button class="action-icon comment-btn"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2z"/></svg><span>Comment</span></button>
      <button class="action-icon replay-btn"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg><span>Replay</span></button>
    </div>
    <div class="play-pause-overlay"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></div>
  `;
  return slide;
}

function renderHistoryGallery() {
  historyGallery.innerHTML = '';
  if (savedTikToks.length === 0) {
    historyGallery.innerHTML = `<p class="gallery-placeholder">Saved TikToks will appear here.</p>`;
    return;
  }
  // The savedTikToks array is already sorted newest-first.
  for (const tiktok of savedTikToks) {
    const thumb = document.createElement('div');
    thumb.className = 'gallery-thumbnail';
    thumb.dataset.tiktokId = tiktok.id;
    thumb.innerHTML = `
      <img src="${tiktok.slides[0].imageSrc}" alt="Thumbnail for ${tiktok.prompt}">
      <div class="gallery-prompt">${tiktok.prompt}</div>
    `;
    historyGallery.append(thumb);
  }
}

// --- Observers & Scrolling ---

function setupTikTokObserver() {
  tiktokObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          if (activeTikTokContainer !== entry.target) {
            stopSlideshow();
            activeTikTokContainer = entry.target as HTMLElement;
            setupSlideObserverForActiveTikTok();
          }
        }
      });
    },
    {root: slideshow, threshold: 0.8},
  );
}

function setupSlideObserverForActiveTikTok() {
  if (slideObserver) slideObserver.disconnect();
  if (!activeTikTokContainer) return;

  const horizontalSlider = activeTikTokContainer.querySelector(
    '.horizontal-slider',
  ) as HTMLElement;
  slideObserver = new IntersectionObserver(
    (entries) => {
      let isAtBounds = false;
      entries.forEach((entry) => {
        const slide = entry.target as HTMLElement;
        slide.classList.toggle('is-visible', entry.isIntersecting);

        if (entry.isIntersecting) {
          const isFirst = !slide.previousElementSibling;
          const isLast = !slide.nextElementSibling;
          if (isFirst || isLast) isAtBounds = true;
        }
      });
      slideshow.style.overflowY = isAtBounds ? 'auto' : 'hidden';
    },
    {root: horizontalSlider, threshold: 0.8},
  );

  horizontalSlider
    .querySelectorAll('.slide')
    .forEach((slide) => slideObserver!.observe(slide));
}

function navigateVertically(direction: 'up' | 'down') {
  if (!activeTikTokContainer) return;
  const target =
    direction === 'up'
      ? (activeTikTokContainer.previousElementSibling as HTMLElement)
      : (activeTikTokContainer.nextElementSibling as HTMLElement);
  target?.scrollIntoView({behavior: 'smooth'});
}

// --- Playback Controls ---
function startSlideshow() {
  if (!activeTikTokContainer) return;
  const tiktokId = activeTikTokContainer.dataset.tiktokId;
  const tiktok = savedTikToks.find((t) => t.id === tiktokId);
  const slider = activeTikTokContainer.querySelector(
    '.horizontal-slider',
  ) as HTMLElement;
  if (!slider || slider.children.length === 0 || !tiktok) return;

  stopSlideshow();

  isPlaying = true;
  document.body.classList.remove('slideshow-paused');

  // Set up instrumental track (common for both modes)
  if (tiktok.instrumentalId) {
    const instrumentalEl = document.querySelector(
      `#${tiktok.instrumentalId}`,
    ) as HTMLAudioElement;
    if (instrumentalEl) {
      currentInstrumentalAudio = instrumentalEl;
      currentInstrumentalAudio.currentTime = 0;
      currentInstrumentalAudio.volume = 0.2; // Quieter for browser TTS
      currentInstrumentalAudio.load(); // Ensure it's ready
      currentInstrumentalAudio.play().catch((e) => {
        showErrorPopup(`Instrumental playback failed:\n${e.message}`);
      });
    }
  } else if (tiktok.instrumentalSrc) {
    currentInstrumentalAudio = new Audio(tiktok.instrumentalSrc);
    currentInstrumentalAudio.loop = true;
    currentInstrumentalAudio.volume = 0.4;
    currentInstrumentalAudio.play().catch((e) => {
      showErrorPopup(`Instrumental playback failed:\n${e.message}`);
    });
  }

  if (tiktok.useBrowserTTS) {
    // --- Browser TTS Playback Logic ---
    let currentSlideIndex = 0;
    const speakAndAdvance = () => {
      if (currentSlideIndex >= tiktok.slides.length || !isPlaying) {
        stopSlideshow();
        return;
      }

      const slide = slider.children[currentSlideIndex] as HTMLElement;
      slide?.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'start',
      });

      const lyrics = tiktok.slides[currentSlideIndex].lyrics;
      if (!lyrics?.trim()) {
        currentSlideIndex++;
        speakAndAdvance();
        return;
      }
      const utterance = new SpeechSynthesisUtterance(lyrics);

      // Find and set the selected voice
      if (tiktok.voiceName) {
        const voices = speechSynthesis.getVoices();
        const selectedVoice = voices.find(
          (voice) => voice.name === tiktok.voiceName,
        );
        if (selectedVoice) {
          utterance.voice = selectedVoice;
        }
      }

      utterance.onend = () => {
        currentSlideIndex++;
        speakAndAdvance();
      };
      utterance.onerror = (e) => {
        console.error('SpeechSynthesis Error:', e);
        showErrorPopup(`Speech synthesis failed: ${e.error}`);
        stopSlideshow();
      };
      speechSynthesis.speak(utterance);
    };
    speakAndAdvance();
  } else if (tiktok.songSrc) {
    // --- ElevenLabs Audio File Playback Logic ---
    currentAudio = new Audio(tiktok.songSrc);
    currentAudio.play().catch((e) => {
      showErrorPopup(`Vocal playback failed:\n${e.message}`);
      stopSlideshow();
    });
    currentAudio.onended = () => stopSlideshow();
    // FIX: Use the 'error' property of the audio element for a more descriptive message,
    // and to resolve the type error on the event object.
    currentAudio.onerror = () => {
      const audioError = currentAudio?.error;
      const errorMessage = audioError
        ? `${audioError.message} (code: ${audioError.code})`
        : 'An unknown error occurred.';
      showErrorPopup(`Vocal playback failed:\n${errorMessage}`);
      stopSlideshow();
    };

    let lastSlideIndex = -1;
    currentAudio.addEventListener('timeupdate', () => {
      if (!currentAudio || currentAudio.paused || !currentAudio.duration)
        return;
      const slideDuration = currentAudio.duration / tiktok.slides.length;
      const currentSlideIndex = Math.floor(
        currentAudio.currentTime / slideDuration,
      );

      if (
        currentSlideIndex !== lastSlideIndex &&
        currentSlideIndex < tiktok.slides.length
      ) {
        const currentSlide = slider.children[currentSlideIndex] as HTMLElement;
        currentSlide?.scrollIntoView({
          behavior: 'smooth',
          block: 'nearest',
          inline: 'start',
        });
        lastSlideIndex = currentSlideIndex;
      }
    });
  }
}

function stopSlideshow() {
  isPlaying = false;
  document.body.classList.add('slideshow-paused');
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  if (currentInstrumentalAudio) {
    currentInstrumentalAudio.pause();
    currentInstrumentalAudio = null;
  }
  if (speechSynthesis.speaking) {
    speechSynthesis.cancel();
  }
}

function handleReplay() {
  if (!activeTikTokContainer) return;
  const slider = activeTikTokContainer.querySelector('.horizontal-slider');
  slider?.scrollTo({left: 0, behavior: 'smooth'});
  stopSlideshow();
  setTimeout(startSlideshow, 500);
}

// --- Theme Management ---

function setupTheme() {
  const savedTheme = localStorage.getItem('theme');
  if (savedTheme === 'light') {
    document.body.classList.add('light-mode');
    updateThemeIcons(true);
  } else {
    updateThemeIcons(false);
  }
}

function toggleTheme() {
  const isLight = document.body.classList.toggle('light-mode');
  localStorage.setItem('theme', isLight ? 'light' : 'dark');
  updateThemeIcons(isLight);
}

function updateThemeIcons(isLight: boolean) {
  if (themeToggle) {
    const sunIcon = themeToggle.querySelector('.sun-icon') as HTMLElement;
    const moonIcon = themeToggle.querySelector('.moon-icon') as HTMLElement;
    if (sunIcon && moonIcon) {
      sunIcon.style.display = isLight ? 'none' : 'block';
      moonIcon.style.display = isLight ? 'block' : 'none';
    }
  }
}

// --- Event Listeners Setup ---

function setupEventListeners() {
  slideshow.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const actionTarget = target.closest('.action-icon');
    if (actionTarget?.classList.contains('replay-btn')) {
      handleReplay();
    } else if (!actionTarget) {
      isPlaying ? stopSlideshow() : startSlideshow();
    }
  });

  generateBtn.addEventListener('click', generate);

  themeToggle.addEventListener('click', toggleTheme);

  addApiBtn.addEventListener('click', () => toggleApiKeyModal(true));
  closeApiKeyModalBtn.addEventListener('click', () => toggleApiKeyModal(false));
  modalOverlay.addEventListener('click', () => {
    toggleApiKeyModal(false);
    closeErrorPopup();
  });
  saveApiKeysBtn.addEventListener('click', saveApiKeys);
  closeErrorModalBtn.addEventListener('click', closeErrorPopup);

  examplesSelector.addEventListener('change', () => {
    if (examplesSelector.value) {
      userInput.value = examplesSelector.value;
      generate();
      examplesSelector.selectedIndex = 0;
    }
  });

  historyGallery.addEventListener('click', (e) => {
    const thumb = (e.target as HTMLElement).closest<HTMLElement>(
      '.gallery-thumbnail',
    );
    if (thumb?.dataset.tiktokId) {
      const tiktok = savedTikToks.find((l) => l.id === thumb.dataset.tiktokId);
      tiktok?.element?.scrollIntoView({behavior: 'smooth'});
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.target === userInput || e.target === characterInput) return;
    if (e.key === 'ArrowDown') navigateVertically('down');
    else if (e.key === 'ArrowUp') navigateVertically('up');
  });
}
