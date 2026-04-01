import { NextRequest, NextResponse } from 'next/server';
import { ChatGroq } from "@langchain/groq";
import { ChatOpenAI } from "@langchain/openai";

const providers = [
  new ChatGroq({ 
    apiKey: process.env.GROQ_API_KEY, 
    model: "llama-4-scout-17b-16e-instruct" 
  }),
  new ChatOpenAI({ 
    apiKey: process.env.OPENAI_API_KEY, 
    model: "gpt-4o-mini" 
  }),
  new ChatOpenAI({ 
    apiKey: process.env.OPENROUTER_API_KEY, 
    model: "anthropic/claude-3.5-sonnet",
    configuration: {
      baseURL: "https://openrouter.ai/api/v1"
    }
  }),
  new ChatOpenAI({ 
    apiKey: process.env.HUGGINGFACE_API_KEY, 
    model: "meta-llama/Meta-Llama-3-8B-Instruct",
    configuration: {
      baseURL: "https://api-inference.huggingface.co/models"
    }
  }),
];

async function askWithFallback(prompt: string) {
  for (const provider of providers) {
    try {
      const res = await provider.invoke(prompt);
      return res;
    } catch (err: any) {
      console.warn("Provider failed, trying next...", err.message);
    }
  }
  throw new Error("All providers failed");
}

export async function POST(request: NextRequest) {
  try {
    const { content, inputType, difficulty, questionCount = 5 } = await request.json();

    if (!content) {
      return NextResponse.json({ error: 'Content is required' }, { status: 400 });
    }

    let prompt = '';
    
    if (inputType === 'topic') {
      prompt = `Create a quiz about "${content}" with ${questionCount} multiple choice questions (5-10 questions). 
      
      Requirements:
      - Each question should have 4 options (A, B, C, D)
      - Only one option should be correct
      - Include the correct answer for each question
      - Make questions engaging and educational
      - Difficulty level: ${difficulty || 'medium'}
      
      Format the response as a JSON object with this structure:
      {
        "title": "Quiz Title",
        "description": "Brief description of the quiz",
        "questions": [
          {
            "question": "Question text here?",
            "options": {
              "A": "Option A",
              "B": "Option B", 
              "C": "Option C",
              "D": "Option D"
            },
            "correctAnswer": "A",
            "explanation": "Brief explanation of why this is correct"
          }
        ]
      }
      
      Make sure the response is valid JSON.`;
    } else {
      // For file or text input
      prompt = `Based on the following content, create a quiz with ${questionCount} multiple choice questions (5-10 questions).

      Content:
      ${content}

      Requirements:
      - Each question should have 4 options (A, B, C, D)
      - Only one option should be correct
      - Include the correct answer for each question
      - Make questions engaging and educational based on the provided content
      - Difficulty level: ${difficulty || 'medium'}
      - Questions should test understanding of the key concepts in the content
      
      Format the response as a JSON object with this structure:
      {
        "title": "Quiz Title based on the content",
        "description": "Brief description of the quiz based on the content",
        "questions": [
          {
            "question": "Question text here?",
            "options": {
              "A": "Option A",
              "B": "Option B", 
              "C": "Option C",
              "D": "Option D"
            },
            "correctAnswer": "A",
            "explanation": "Brief explanation of why this is correct"
          }
        ]
      }
      
      Make sure the response is valid JSON.`;
    }

    const result = await askWithFallback(prompt);
    
    // Parse the AI response
    let quizData;
    try {
      // 1. result yoki result.content mavjudligini tekshiramiz
      if (!result || !result.content) {
        throw new Error('AI provayderidan bo‘sh javob keldi');
      }

      // 2. Kontentni string ko'rinishiga keltiramiz
      const contentString = typeof result.content === 'string' 
        ? result.content 
        : JSON.stringify(result.content);

      // 3. Regex match natijasini o'zgaruvchiga olamiz (Xavfsiz usul)
      const jsonMatch = contentString ? contentString.match(/\{[\s\S]*\}/) : null;

      if (jsonMatch && jsonMatch[0]) {
        quizData = JSON.parse(jsonMatch[0]);
      } else {
        console.error("AI javobida JSON topilmadi. Kelgan javob:", contentString);
        throw new Error('No JSON found in response');
      }
    } catch (parseError) {
      console.error('Failed to parse AI response:', parseError);
      return NextResponse.json({ 
        error: 'Failed to generate quiz. Please try again.' 
      }, { status: 500 });
    }
}