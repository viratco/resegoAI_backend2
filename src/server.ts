import express, { Request, Response, Router, RequestHandler, NextFunction } from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import { DOMParser } from '@xmldom/xmldom';
import { createClient } from '@supabase/supabase-js';
import { authenticateToken } from './middleware/auth';

dotenv.config();

const app = express();

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!, 
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

// Configure CORS with middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  methods: ['GET', 'POST'],
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

const PORT = process.env.PORT || 5002;

const router = Router();

interface SearchRequest extends Request {
  body: { query: string }
}

interface AuthenticatedRequest extends Request {
  user?: any;
}

interface Paper {
  title: string;
  authors: string[];
  abstract: string;
  link: string;
}

interface PaperAnalysis {
  paper: Paper;
  analysis: string;
}

const searchPapers = async (req: Request, res: Response): Promise<void> => {
  const { query } = req.body as { query: string };

  if (!query) {
    res.status(400).json({ error: 'Query is required' });
    return;
  }

  try {
    const arxivResponse = await fetch(
      `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=6`
    );

    if (!arxivResponse.ok) {
      throw new Error(`ArXiv API error: ${arxivResponse.statusText}`);
    }

    const xmlData = await arxivResponse.text();
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlData, "text/xml");
    const entries = xmlDoc.getElementsByTagName("entry");

    if (!entries || entries.length === 0) {
      res.json({ papers: [], summaries: [], consolidatedSummary: '' });
      return;
    }
    
    const papers = Array.from(entries).map(entry => ({
      title: entry.getElementsByTagName("title")[0]?.textContent?.replace(/\n/g, ' ').trim() || "",
      authors: Array.from(entry.getElementsByTagName("author")).map(a => a.textContent?.trim() || ""),
      abstract: entry.getElementsByTagName("summary")[0]?.textContent?.trim() || "",
      link: entry.getElementsByTagName("id")[0]?.textContent || ""
    }));

    const summaries = await Promise.all(papers.map(async (paper) => {
      try {
        const aiResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
            'HTTP-Referer': 'http://localhost:5173',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'qwen/qwen2.5-vl-72b-instruct:free',
            messages: [{
              role: 'user',
              content: `Provide a very brief 2-3 bullet point summary of this research paper (max 50 words total):
              Title: ${paper.title}
              Abstract: ${paper.abstract.substring(0, 1000)}`
            }],
            temperature: 0.2,
            max_tokens: 100
          }),
        });

        if (!aiResponse.ok) {
          const errorText = await aiResponse.text();
          console.error('OpenRouter API error:', aiResponse.status, errorText);
          return 'Summary failed due to API error';
        }

        const data = await aiResponse.json();
        if (!data.choices || !Array.isArray(data.choices) || data.choices.length === 0) {
          console.error('Invalid summary response:', data);
          return 'Summary failed: No valid response';
        }

        return data.choices[0]?.message?.content || 'Summary not available';
      } catch (error) {
        console.error('AI Summary error:', error);
        return 'Summary generation failed';
      }
    }));

    const consolidatedResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'http://localhost:5173',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'qwen/qwen2.5-vl-72b-instruct:free',
        messages: [{
          role: 'user',
          content: `Synthesize a cohesive overview of these research papers (max 100 words). Focus on common themes, key findings, and broader implications. Don't list papers individually.

          Papers:
          ${papers.map(paper => `${paper.title}\n${paper.abstract}`).join('\n\n')}`
        }],
        temperature: 0.3,
        max_tokens: 200
      }),
    });

    if (!consolidatedResponse.ok) {
      const errorText = await consolidatedResponse.text();
      console.error('OpenRouter API error:', consolidatedResponse.status, errorText);
      throw new Error('Failed to generate consolidated summary');
    }

    const consolidatedData = await consolidatedResponse.json();
    if (!consolidatedData.choices || !Array.isArray(consolidatedData.choices) || consolidatedData.choices.length === 0) {
      console.error('Invalid consolidated summary response:', consolidatedData);
      throw new Error('Invalid consolidated summary response');
    }

    const consolidatedSummary = consolidatedData.choices[0]?.message?.content || 'Overview not available';

    res.json({ papers, summaries, consolidatedSummary });
  } catch (error) {
    console.error('Server error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    res.status(500).json({ error: errorMessage });
  }
};

const authenticateUser = (async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    res.status(401).json({ error: 'No authorization header' });
    return;
  }

  try {
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }

    req.user = user;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Authentication failed' });
  }
}) as RequestHandler;

router.post('/api/search-papers', authenticateToken, (async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await searchPapers(req, res);
  } catch (error) {
    next(error);
  }
}) as RequestHandler);

router.post('/api/generate-report', authenticateToken, (async (req: Request, res: Response): Promise<void> => {
  try {
    const { query } = req.body;
    let papers: Paper[] = [];
    
    if (!query) {
      res.status(400).json({ error: 'Query is required' });
      return;
    }

    try {
      const arxivResponse = await fetch(
        `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=5`
      );
      
      if (!arxivResponse.ok) {
        throw new Error('Failed to fetch papers from arXiv');
      }

      const xmlData = await arxivResponse.text();
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(xmlData, "text/xml");
      const entries = xmlDoc.getElementsByTagName("entry");
      
      papers = Array.from(entries).map(entry => ({
        title: entry.getElementsByTagName("title")[0]?.textContent?.replace(/\n/g, ' ').trim() || "",
        authors: Array.from(entry.getElementsByTagName("author")).map(a => a.textContent?.trim() || ""),
        abstract: entry.getElementsByTagName("summary")[0]?.textContent?.trim() || "",
        link: entry.getElementsByTagName("id")[0]?.textContent || ""
      }));
    } catch (error) {
      console.error('ArXiv fetch error:', error);
      res.status(500).json({ error: 'Failed to fetch papers from arXiv' });
      return;
    }

    const paperAnalyses = await Promise.all(papers.map(async (paper: Paper) => {
      try {
        const analysisResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
            'HTTP-Referer': 'http://localhost:5173',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'qwen/qwen2.5-vl-72b-instruct:free',
            messages: [{
              role: 'user',
              content: `Analyze this research paper and provide the following details in a structured format:
                - Research question
                - Study methodology
                - Key findings
                - Limitations
                - Conclusion

                Title: ${paper.title}
                Abstract: ${paper.abstract}`
            }],
            temperature: 0.3,
            max_tokens: 500
          }),
        });

        if (!analysisResponse.ok) {
          const errorText = await analysisResponse.text();
          console.error('OpenRouter API error:', analysisResponse.status, errorText);
          return { paper, analysis: 'Analysis failed due to API error' };
        }

        const data = await analysisResponse.json();
        if (!data.choices || !Array.isArray(data.choices) || data.choices.length === 0) {
          console.error('Invalid analysis response:', data);
          return { paper, analysis: 'Analysis failed: No valid response from AI' };
        }

        return {
          paper,
          analysis: data.choices[0]?.message?.content || 'Analysis failed'
        } as PaperAnalysis;
      } catch (error) {
        console.error('Paper analysis error:', error);
        return { paper, analysis: 'Analysis failed due to server error' };
      }
    }));

    const reportPrompt = `Generate a comprehensive, evidence-based research report on "${query}" in a structured academic format. Base the analysis solely on the provided papers, ensuring all claims are supported by their findings. Follow this format precisely, keeping sections concise (max 150 words each unless specified) and avoiding vague generalizations. Use an academic writing style.

---

## ${query}  
*Generated on ${new Date().toLocaleDateString()}*

---

### Abstract  
Summarize the research (100-150 words):  
- Objective: What is the main goal of this research?  
- Methodology: Overview of key methods used across papers.  
- Findings: Highlight 2-3 major results.  
- Significance: Why do these findings matter?  

---

### Introduction  
Provide context (100-150 words):  
- Background: Why is "${query}" a significant topic?  
- Problem Statement: What specific issue does this research address?  
- Research Questions: List 2-3 key questions explored in the papers.  
- Scope: Focus on insights from the provided papers only.  

---

### Literature Review  
Analyze existing research (150-200 words):  
- Current State: Summarize trends from the papers.  
- Frameworks: Identify common theories or models (if any).  
- Gaps: Highlight 1-2 gaps the papers address or leave unresolved.  
- Key Terms: Define 2-3 critical concepts from the papers.  

---

### Methodology  
Detail methods (150 words):  
- Approach: Qualitative, quantitative, or mixed?  
- Data Sources: Types of data used in the papers (e.g., experiments, surveys).  
- Analysis Techniques: Specific methods (e.g., statistical tests, simulations).  
- Tools: Mention software or frameworks (if specified).  

---

### Results and Analysis  
Present findings in a table (max 5 rows), followed by a brief analysis (150 words):  

| Category         | Finding             | Evidence (Cite Paper Title) | Impact             |  
|------------------|---------------------|-----------------------------|--------------------|  
| [e.g., Efficiency] | [e.g., 20% improvement] | [e.g., "Paper Title"]   | [e.g., Scalability] |  

- Analysis: Compare findings, note strengths/weaknesses, and link to evidence.  

---

### Discussion  
Evaluate implications (150 words):  
- Interpretation: What do the results mean for "${query}"?  
- Comparison: How do findings align with broader research?  
- Implications: 1-2 practical or theoretical applications.  
- Limitations: 1-2 constraints from the papers.  

---

### Conclusion  
Summarize takeaways (100-150 words):  
- Contributions: 1-2 new insights from the papers.  
- Key Insights: What should readers remember?  
- Future Directions: 1-2 specific research questions for future work.  

---

### References  
List all papers in APA format:  
- [Author(s)]. ([Year]). [Title]. [Link].  

---

**Guidelines:**  
1. Use only the provided papers as the dataset.  
2. Cite paper titles in the text (e.g., "As shown in 'Paper Title'").  
3. Include quantitative data (e.g., percentages, metrics) where available.  
4. Avoid speculation; ground all statements in the papers’ abstracts or analyses.  
5. Ensure table data is concise and relevant to "${query}".  

**Dataset:**  
${paperAnalyses.map(({ paper, analysis }) => 
  `Title: **${paper.title}**  
   Authors: ${paper.authors.join(', ')}  
   Abstract: ${paper.abstract}  
   Analysis: ${analysis}  
  `
).join('\n')}`;

    try {
      const headers: HeadersInit = {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': process.env.CORS_ORIGIN || 'http://localhost:5173',
        'Content-Type': 'application/json'
      };

      if (process.env.OPENROUTER_ORG_ID) {
        headers['OpenAI-Organization'] = process.env.OPENROUTER_ORG_ID;
      }

      const reportResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'qwen/qwen2.5-vl-72b-instruct:free',
          messages: [{
            role: 'user',
            content: reportPrompt
          }],
          temperature: 0.3,
          max_tokens: 2000
        }),
      });

      if (!reportResponse.ok) {
        const error = await reportResponse.json();
        console.error('Report generation API error:', reportResponse.status, error);
        throw new Error(error.message || 'OpenRouter API error');
      }

      const reportData = await reportResponse.json();
      if (!reportData.choices || !Array.isArray(reportData.choices) || reportData.choices.length === 0) {
        console.error('Invalid report response:', reportData);
        throw new Error('Failed to generate report: No valid response from AI');
      }

      const finalReport = reportData.choices[0]?.message?.content;

      if (!finalReport) {
        throw new Error('No report content generated');
      }

      try {
        const user = (req as any).user;
        if (!user || !user.id) {
          throw new Error('No authenticated user found');
        }

        const { data: reportRecord, error: saveError } = await supabase
          .from('reports')
          .insert({
            user_id: user.id,
            title: query,
            content: finalReport
          })
          .select()
          .single();

        if (saveError) {
          console.error('Supabase save error:', saveError);
          throw new Error(`Failed to save report: ${saveError.message}`);
        }

        if (!reportRecord) {
          throw new Error('No report record returned after save');
        }

        res.json({
          report: finalReport,
          papers: paperAnalyses,
          savedReport: reportRecord
        });
      } catch (error) {
        console.error('Database save error:', error);
        res.status(500).json({ 
          error: error instanceof Error ? error.message : 'Failed to save report to database' 
        });
      }
    } catch (error) {
      console.error('Report generation error:', error);
      res.status(500).json({ error: 'Failed to generate report content' });
    }
  } catch (error) {
    console.error('General error:', error);
    res.status(500).json({ 
      error: error instanceof Error ? error.message : 'Failed to process request'
    });
  }
}) as RequestHandler);

router.post('/api/suggest-prompt', authenticateUser, (async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { initialQuery } = req.body;
    const suggestionResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'http://localhost:5173',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'qwen/qwen2.5-vl-72b-instruct:free',
        messages: [{
          role: 'user',
          content: `As a research assistant, analyze this query and suggest improvements:
          
          Original query: "${initialQuery}"

          Provide response in this JSON format:
          {
            "refinedQuery": "improved version of the query",
            "suggestedElements": {
              "specificity": [
                "specific aspect 1",
                "specific aspect 2"
              ],
              "researchType": [
                "methodology 1",
                "methodology 2"
              ],
              "practicalApplication": [
                "application 1",
                "application 2"
              ]
            },
            "questionVariations": [
              {
                "question": "more specific version of the query",
                "explanation": "why this version is more effective"
              },
              {
                "question": "alternative approach to the query",
                "explanation": "how this approach differs"
              }
            ],
            "relatedConcepts": [
              "technical term 1",
              "technical term 2"
            ]
          }

          Guidelines:
          1. Make suggestions more specific and measurable
          2. Include relevant technical terms
          3. Consider different research approaches
          4. Focus on practical applications
          5. Break down complex queries into specific elements`
        }],
        temperature: 0.3,
        max_tokens: 800
      }),
    });

    if (!suggestionResponse.ok) {
      const errorText = await suggestionResponse.text();
      console.error('OpenRouter API error:', suggestionResponse.status, errorText);
      throw new Error('Failed to generate prompt suggestion');
    }

    const data = await suggestionResponse.json();
    if (!data.choices || !Array.isArray(data.choices) || data.choices.length === 0) {
      console.error('Invalid suggestion response:', data);
      throw new Error('Invalid suggestion response');
    }

    const suggestions = JSON.parse(data.choices[0]?.message?.content || '{}');
    
    const researchTags = await getResearchTags(initialQuery);
    suggestions.researchTags = researchTags;

    res.json(suggestions);
  } catch (error) {
    next(error);
  }
}) as RequestHandler);

async function getResearchTags(query: string): Promise<string[]> {
  try {
    const tagResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'http://localhost:5173',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'qwen/qwen2.5-vl-72b-instruct:free',
        messages: [{
          role: 'user',
          content: `Generate 3-4 relevant research type tags for this query: "${query}"
          Return only the tags separated by commas, like: "Specificity, Research type, Practical application"`
        }],
        temperature: 0.2,
        max_tokens: 100
      }),
    });

    if (!tagResponse.ok) {
      const errorText = await tagResponse.text();
      console.error('OpenRouter API error:', tagResponse.status, errorText);
      return [];
    }

    const data = await tagResponse.json();
    if (!data.choices || !Array.isArray(data.choices) || data.choices.length === 0) {
      console.error('Invalid tag response:', data);
      return [];
    }

    return data.choices[0]?.message?.content.split(',').map((tag: string) => tag.trim()) || [];
  } catch (error) {
    console.error('Tag generation error:', error);
    return [];
  }
}

router.post('/api/analyze-paper', authenticateToken, (async (req: Request, res: Response): Promise<void> => {
  try {
    const { abstract } = req.body;
    
    if (!abstract) {
      res.status(400).json({ error: 'Abstract is required' });
      return;
    }

    const requestBody = {
      model: 'qwen/qwen2.5-vl-72b-instruct:free',
      messages: [{
        role: 'user',
        content: `Summarize this research paper abstract in 35 words or less. Output only the summary text, no preamble, labels, or additional commentary.

        Abstract: ${abstract}`
      }],
      temperature: 0.3,
      max_tokens: 50,
      min_new_tokens: 1
    };

    console.log('Request body:', JSON.stringify(requestBody, null, 2));

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': process.env.CORS_ORIGIN || 'http://localhost:5173',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('OpenRouter API error:', response.status, errorText);
      throw new Error(`Failed to generate AI summary: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    console.log('API response:', JSON.stringify(data, null, 2));

    if (!data.choices || !Array.isArray(data.choices) || data.choices.length === 0) {
      console.error('Invalid analysis response:', data);
      throw new Error('Invalid analysis response: No valid choices in response');
    }

    const summary = data.choices[0]?.message?.content;
    if (!summary) {
      console.error('No summary content in response:', data.choices[0]);
      throw new Error('No summary content generated');
    }

    res.json({ summary });
  } catch (error) {
    console.error('Error analyzing paper:', error);
    res.status(500).json({ 
      error: error instanceof Error ? error.message : 'Failed to analyze paper' 
    });
  }
}) as RequestHandler);

router.post('/api/save-search', authenticateToken, (async (req: Request, res: Response): Promise<void> => {
  try {
    const { query, papers, consolidatedSummary } = req.body;
    const user = (req as any).user;

    if (!user || !user.id) {
      throw new Error('No authenticated user found');
    }

    const { data: savedSearch, error: saveError } = await supabase
      .from('reports')
      .insert({
        user_id: user.id,
        title: query,
        content: consolidatedSummary,
        papers: papers,
        type: 'search',
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (saveError) {
      console.error('Supabase save error:', saveError);
      throw new Error(`Failed to save search: ${saveError.message}`);
    }

    res.json({
      savedSearch,
      message: 'Search saved successfully'
    });
  } catch (error) {
    console.error('Save search error:', error);
    res.status(500).json({ 
      error: error instanceof Error ? error.message : 'Failed to save search'
    });
  }
}) as RequestHandler);

app.use(router);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});