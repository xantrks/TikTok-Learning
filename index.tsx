/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleGenAI, Modality} from '@google/genai';
import {marked} from 'marked';

// --- Interfaces ---
interface SlideData {
  text: string;
  imageSrc: string;
}

interface TikTok {
  id: string;
  slides: SlideData[];
  character: string;
  prompt: string;
  voiceName: string; // Voice is now saved with the TikTok
  element?: HTMLElement;
}

// --- DOM Elements ---
let ai: GoogleGenAI;
const userInput = document.querySelector('#input') as HTMLTextAreaElement;
const slideshow = document.querySelector('#slideshow') as HTMLDivElement;
const error = document.querySelector('#error') as HTMLDivElement;
const characterSelector = document.querySelector(
  '#character-selector',
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
const voiceSelector = document.querySelector(
  '#voice-selector',
) as HTMLSelectElement;
const backgroundMusic = document.querySelector(
  '#background-music',
) as HTMLAudioElement;
const apiKeyOverlay = document.querySelector(
  '#api-key-overlay',
) as HTMLDivElement;
const apiKeyModal = document.querySelector('#api-key-modal') as HTMLDivElement;
const apiKeyForm = document.querySelector('#api-key-form') as HTMLFormElement;
const apiKeyInput = document.querySelector(
  '#api-key-input',
) as HTMLInputElement;

// --- State Management ---
let selectedCharacter = 'cat';
let selectedVoiceName = '';
let voices: SpeechSynthesisVoice[] = [];
let isPlaying = false;
let isGenerating = false;
let savedTikToks: TikTok[] = [];
let speechKeepAliveInterval: number | undefined;
let musicHasStarted = false;
let tiktokObserver: IntersectionObserver;
let slideObserver: IntersectionObserver | null = null;
let activeTikTokContainer: HTMLElement | null = null;

// --- Initialization ---
init();

function init() {
  setupEventListeners();
  setupTikTokObserver();
  setupTheme();
  if ('speechSynthesis' in window) {
    window.speechSynthesis.onvoiceschanged = loadVoices;
    loadVoices(); // Initial call
  }
  renderHistoryGallery();
  checkApiKey();
}

// --- API Key Management ---
function checkApiKey() {
  const apiKey = sessionStorage.getItem('gemini-api-key');
  if (apiKey) {
    initializeGenAI(apiKey);
  } else {
    showApiKeyModal();
  }
}

function initializeGenAI(apiKey: string) {
  try {
    ai = new GoogleGenAI({apiKey});
    hideApiKeyModal();
  } catch (e) {
    console.error('Failed to initialize GoogleGenAI:', e);
    showApiKeyModal();
    const existingError = apiKeyModal.querySelector('.api-key-error');
    if (existingError) existingError.remove();
    const errorP = document.createElement('p');
    errorP.className = 'api-key-error';
    errorP.style.color = 'var(--primary-accent)';
    errorP.style.marginTop = '10px';
    errorP.textContent = `Initialization failed. Please check your API key.`;
    apiKeyForm.insertAdjacentElement('afterend', errorP);
  }
}

function showApiKeyModal() {
  apiKeyOverlay.removeAttribute('hidden');
  apiKeyModal.removeAttribute('hidden');
  generateBtn.disabled = true;
}

function hideApiKeyModal() {
  apiKeyOverlay.setAttribute('hidden', 'true');
  apiKeyModal.setAttribute('hidden', 'true');
  generateBtn.disabled = false;
}

function handleApiKeySubmit(event: Event) {
  event.preventDefault();
  const apiKey = apiKeyInput.value.trim();
  if (apiKey) {
    const existingError = apiKeyModal.querySelector('.api-key-error');
    if (existingError) existingError.remove();
    sessionStorage.setItem('gemini-api-key', apiKey);
    initializeGenAI(apiKey);
  }
}

// --- Core Functions ---

function loadVoices() {
  const allEnglishVoices = window.speechSynthesis
    .getVoices()
    .filter((v) => v.lang.startsWith('en'));
  const googleVoices = allEnglishVoices.filter((v) =>
    v.name.includes('Google'),
  );

  const voicesToUse = googleVoices.length > 0 ? googleVoices : allEnglishVoices;
  voices = voicesToUse;

  voiceSelector.innerHTML = '';

  if (voices.length === 0) {
    const option = document.createElement('option');
    option.textContent = 'No voices available';
    option.disabled = true;
    voiceSelector.append(option);
    return;
  }

  const defaultVoice =
    voices.find((voice) => voice.name.includes('Female')) || voices[0];

  voices.forEach((voice) => {
    const option = document.createElement('option');
    option.value = voice.name;
    option.textContent = `${voice.name} (${voice.lang})`;
    if (voice.name === defaultVoice.name) {
      option.selected = true;
    }
    voiceSelector.append(option);
  });

  selectedVoiceName = voiceSelector.value;
}

function speak(text: string, voiceName: string, onEndCallback: () => void) {
  if (!('speechSynthesis' in window)) return;

  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  const voiceToUse = voices.find((v) => v.name === voiceName);

  utterance.voice =
    voiceToUse || voices.find((v) => v.lang.startsWith('en')) || voices[0];
  utterance.pitch = 1.2;
  utterance.rate = 0.9;
  utterance.volume = 1;
  utterance.onend = onEndCallback;
  utterance.onerror = (event) => {
    console.error('SpeechSynthesisUtterance.onerror:', event.error);
    if (event.error !== 'interrupted') {
      stopSlideshow();
      onEndCallback(); // Ensure callbacks fire on error to prevent getting stuck
    }
  };
  window.speechSynthesis.speak(utterance);
}

function getInstructions(character: string): string {
  const baseInstructions = `
    Generate a 6 part explanation, with each part having one sentence of text and one image.
    Keep sentences short, conversational, casual, and engaging for a child.
    The response must have exactly 6 parts.
    Generate a cute, colorful, and simple illustration for each sentence.
    Do NOT include any text, words, or letters in the generated image itself.
    No commentary, just begin your explanation.`;

  switch (character) {
    case 'dog':
      return `Use a fun story about a pack of friendly, loyal dogs as a metaphor. ${baseInstructions}`;
    case 'spiderman':
      return `Explain it from the perspective of Spider-Man, using concepts like web-slinging, spider-sense, and great responsibility as metaphors. ${baseInstructions}`;
    case 'doraemon':
      return `Explain it from the perspective of Doraemon, using his futuristic gadgets from the 22nd century as metaphors. ${baseInstructions}`;
    case 'barbie':
      return `Explain it from the perspective of Barbie, using fashion, friendship, and her careers as metaphors. ${baseInstructions}`;
    case 'simba':
      return `Explain it from the perspective of Simba from The Lion King, using the circle of life, the pride lands, and his jungle friends as metaphors. ${baseInstructions}`;
    case 'ironman':
      return `Explain it from the perspective of Tony Stark (Iron Man), using advanced technology, engineering, and his suit's gadgets as metaphors. ${baseInstructions}`;
    case 'steve':
      return `Explain it from the perspective of Steve from Minecraft, using concepts like crafting, building with blocks, mining, and exploring the world as metaphors. ${baseInstructions}`;
    case 'cat':
    default:
      return `Use a fun story about lots of tiny, curious cats as a metaphor. ${baseInstructions}`;
  }
}

async function generate() {
  if (!ai) {
    showApiKeyModal();
    return;
  }

  const message = userInput.value.trim();
  if (!message || isGenerating) return;

  if (!musicHasStarted && backgroundMusic) {
    backgroundMusic.volume = 0.2;
    backgroundMusic.play().catch((e) => console.error('Audio play failed:', e));
    musicHasStarted = true;
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
    const newTikTok: TikTok = {
      id: Date.now().toString(),
      slides: [],
      character: selectedCharacter,
      prompt: message,
      voiceName: selectedVoiceName, // Save the selected voice
    };

    userInput.value = '';
    const instructions = getInstructions(selectedCharacter);
    const chat = ai.chats.create({
      model: 'gemini-2.5-flash-image-preview',
      config: {responseModalities: [Modality.TEXT, Modality.IMAGE]},
    });
    const result = await chat.sendMessageStream({
      message: `${message}\n${instructions}`,
    });

    let text = '';
    let imgData = '';

    for await (const chunk of result) {
      for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
        if (part.text) {
          text += part.text;
        } else if (part.inlineData?.data) {
          imgData = `data:image/png;base64,${part.inlineData.data}`;
        }
        if (text && imgData && newTikTok.slides.length < 5) {
          newTikTok.slides.push({text, imageSrc: imgData});
          text = '';
          imgData = '';
        }
      }
    }
    if (text && imgData && newTikTok.slides.length < 5) {
      newTikTok.slides.push({text, imageSrc: imgData});
    }

    if (newTikTok.slides.length > 0) {
      saveAndRenderNewTikTok(newTikTok);
    } else {
      throw new Error('No content was generated. Please try again.');
    }
  } catch (e) {
    const msg = String(e);
    error.innerHTML = `Something went wrong: ${msg}`;
    error.removeAttribute('hidden');
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

function saveAndRenderNewTikTok(tiktok: TikTok) {
  savedTikToks.push(tiktok);
  renderHistoryGallery();
  addTikTokToFeed(tiktok);
  tiktok.element?.scrollIntoView({behavior: 'smooth'});
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
  slideshow.append(tiktokContainer);
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
        <span class="creator-name">@${characterName}</span>
        ${prompt}
      </div>
      <div class="slide-answer">${marked.parse(slideData.text)}</div>
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

function playNextSlide(
  slider: HTMLElement,
  slideIndex: number,
  voiceName: string,
) {
  if (!isPlaying || slideIndex >= slider.children.length) {
    stopSlideshow();
    return;
  }
  const currentSlide = slider.children[slideIndex] as HTMLElement;
  currentSlide.scrollIntoView({behavior: 'smooth'});
  const caption = currentSlide.querySelector('.slide-answer p');
  if (caption?.textContent) {
    setTimeout(() => {
      if (!isPlaying) return;
      speak(caption.textContent!.trim(), voiceName, () => {
        playNextSlide(slider, slideIndex + 1, voiceName);
      });
    }, 700);
  }
}

function startSlideshow() {
  if (!activeTikTokContainer) return;
  const tiktokId = activeTikTokContainer.dataset.tiktokId;
  const tiktok = savedTikToks.find((t) => t.id === tiktokId);
  const slider = activeTikTokContainer.querySelector('.horizontal-slider');
  if (!slider || slider.children.length === 0 || !tiktok) return;

  isPlaying = true;
  document.body.classList.remove('slideshow-paused');

  if ('speechSynthesis' in window) {
    if (speechKeepAliveInterval) clearInterval(speechKeepAliveInterval);
    speechKeepAliveInterval = window.setInterval(
      () =>
        window.speechSynthesis.speaking
          ? window.speechSynthesis.resume()
          : window.speechSynthesis.pause(),
      5000,
    );
  }

  const slides = Array.from(slider.children);
  const viewportCenter =
    slider.getBoundingClientRect().left + slider.clientWidth / 2;
  const closestSlide = slides.reduce(
    (closest, slide, index) => {
      const {left, right} = slide.getBoundingClientRect();
      const slideCenter = left + (right - left) / 2;
      const distance = Math.abs(viewportCenter - slideCenter);
      if (distance < closest.distance) return {distance, index};
      return closest;
    },
    {distance: Infinity, index: 0},
  );

  playNextSlide(slider as HTMLElement, closestSlide.index, tiktok.voiceName);
}

function stopSlideshow() {
  isPlaying = false;
  document.body.classList.add('slideshow-paused');
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
    if (speechKeepAliveInterval) {
      clearInterval(speechKeepAliveInterval);
      speechKeepAliveInterval = undefined;
    }
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
  apiKeyForm.addEventListener('submit', handleApiKeySubmit);

  characterSelector.addEventListener('change', () => {
    selectedCharacter = characterSelector.value;
  });

  voiceSelector.addEventListener('change', () => {
    selectedVoiceName = voiceSelector.value;
  });

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
    if (e.target === userInput) return;
    if (e.key === 'ArrowDown') navigateVertically('down');
    else if (e.key === 'ArrowUp') navigateVertically('up');
  });
}
