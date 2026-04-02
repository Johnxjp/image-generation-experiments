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
