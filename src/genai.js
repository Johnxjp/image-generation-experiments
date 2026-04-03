import { GoogleGenAI } from "@google/genai"

const ai = new GoogleGenAI({ apiKey: import.meta.env.VITE_GEMINI_API_KEY })

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
    model: "gemma-4-31b-it",
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
