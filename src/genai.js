import { GoogleGenAI } from "@google/genai"
import { fal } from "@fal-ai/client"

const ai = new GoogleGenAI({ apiKey: import.meta.env.VITE_GEMINI_API_KEY })

fal.config({ credentials: import.meta.env.VITE_FAL_KEY })

const PROMPT =
  "Write an image prompt for nanobanana model to create this. Focus on describing the composition, subject actions, colours and style rather than very specific details. Return only the prompt."

/**
 * Takes a data-URL (e.g. from FileReader) and returns the Gemini description.
 */
export async function generateDescription(dataUrl) {
  // dataUrl looks like "data:image/jpeg;base64,/9j/4AAQ..."
  const [meta, base64] = dataUrl.split(",")
  const mimeType = meta.match(/:(.*?);/)?.[1] ?? "image/jpeg"

  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: [
      {
        inlineData: {
          mimeType,
          data: base64,
        },
      },
      { text: PROMPT },
    ],
  })

  return response.text
}

const SPECTRUM_SYSTEM_PROMPT = `You are given a description of an image and a dimension of change. Your job is to generate a spectrum of N image prompts that form a natural progression along that dimension.

Rules:
- Every prompt must describe the same scene, composition, and subjects as the original
- Only the specified dimension should change between steps
- Changes should escalate gradually — each step should feel like a small, natural increment from the previous one
- The first prompt should be close to the original, the last should be the extreme end of the dimension
- If the dimension is abstract or sensory (like "sweetness" or "anger"), translate it into concrete visual properties that a viewer would associate with that quality

Separate each prompt with <prompt></prompt>. For example:

<prompt>
A child blowing out candles on a birthday cake with a thin layer of vanilla buttercream frosting and a few simple piped rosettes, soft pastel yellow tones
</prompt>

<prompt>
A child blowing out candles on a birthday cake covered in smooth, glossy pink frosting with colorful sprinkles scattered across the top and sides, candy letters spelling a name
</prompt>

You will be given an image description, a dimension of change, and the number of steps in the spectrum. 
Generate a spectrum of prompts that follow the rules above.
`

/**
 * Generates N spectrum prompts given an image description, a dimension, and the number of steps.
 * Returns an array of prompt strings.
 */
export async function generateSpectrumPrompts(description, dimension, steps) {
  const userPrompt = `Image description: ${description}\nDimension of change: ${dimension}\nNumber of steps: ${steps}`

  const response = await ai.models.generateContent({
    model: "gemini-3.1-flash-lite-preview",
    config: {
      systemInstruction: SPECTRUM_SYSTEM_PROMPT,
    },
    contents: [{ text: userPrompt }],
  })

  const text = response.text
  const prompts = []
  const regex = /<prompt>([\s\S]*?)<\/prompt>/g
  let match
  while ((match = regex.exec(text)) !== null) {
    prompts.push(match[1].trim())
  }

  return prompts
}

/**
 * Uploads a data URL to FAL CDN, returns the CDN URL.
 */
export async function uploadToFalCdn(dataUrl) {
  const [meta, base64] = dataUrl.split(",")
  const mimeType = meta.match(/:(.*?);/)?.[1] ?? "image/jpeg"
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const blob = new Blob([bytes], { type: mimeType })
  const file = new File([blob], "image." + mimeType.split("/")[1], { type: mimeType })
  return fal.storage.upload(file)
}

/**
 * Generates an edited image using Grok Imagine via FAL.
 * Returns the CDN URL of the generated image.
 */
export async function generateImage(falImageUrl, prompt) {
  const result = await fal.subscribe("xai/grok-imagine-image/edit", {
    input: {
      prompt: "Modify the image according to the new instruction: " + prompt,
      image_urls: [falImageUrl],
      num_images: 1,
    },
  })
  return result.data.images[0].url
}

/**
 * Generates a one-sentence transition prompt connecting two scenes.
 */
export async function generateTransitionPrompt(startPrompt, endPrompt) {
  const response = await ai.models.generateContent({
    model: "gemini-3.1-flash-lite-preview",
    config: {
      systemInstruction:
        "Analyze the two provided scenes and describe a one-sentence transition that connects them by focusing on a single continuous motion. Choose subject motion, camera movement or environmental shift to bridge the scenes, ensuring the transition is concise and avoids overly specific technical jargon.",
    },
    contents: [{ text: `Scene A: ${startPrompt}\n\nScene B: ${endPrompt}` }],
  })
  return response.text
}

/**
 * Generates a transition video between two images using Seedance.
 * Returns the video URL.
 */
export async function generateInterpolationVideo(prompt, startImageUrl, endImageUrl) {
  const result = await fal.subscribe("fal-ai/bytedance/seedance/v1.5/pro/image-to-video", {
    input: {
      prompt,
      aspect_ratio: "16:9",
      resolution: "480p",
      duration: "5",
      enable_safety_checker: true,
      generate_audio: false,
      image_url: startImageUrl,
      end_image_url: endImageUrl,
    },
    logs: true,
    onQueueUpdate: (update) => {
      if (update.status === "IN_PROGRESS") {
        update.logs?.map((log) => log.message).forEach(console.log)
      }
    },
  })
  return result.data.video.url
}

/**
 * Downloads a video from FAL and extracts frames at given timestamps.
 * Returns array of { dataUrl, width, height }.
 */
export async function extractFramesFromVideo(videoUrl, timestamps = [1, 2, 3, 4]) {
  const res = await fetch(videoUrl, {
    headers: { Authorization: `Key ${import.meta.env.VITE_FAL_KEY}` },
  })
  const blob = await res.blob()
  const objectUrl = URL.createObjectURL(blob)

  try {
    const video = document.createElement("video")
    video.src = objectUrl
    video.preload = "auto"
    video.muted = true

    await new Promise((resolve, reject) => {
      video.onloadeddata = resolve
      video.onerror = reject
    })

    const canvas = document.createElement("canvas")
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext("2d")
    const frames = []

    for (const t of timestamps) {
      video.currentTime = t
      await new Promise((r) => { video.onseeked = r })
      ctx.drawImage(video, 0, 0)
      frames.push({
        dataUrl: canvas.toDataURL("image/jpeg", 0.9),
        width: video.videoWidth,
        height: video.videoHeight,
      })
    }

    return frames
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}
