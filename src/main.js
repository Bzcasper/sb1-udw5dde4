import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv'; 
import { ScraperService } from './services/scraper.js';
import { FileService } from './services/file-service.js';
import { TemplateService } from './services/template-service.js';

// Validate Obsidian vault path on startup
FileService.validateVaultPath()
  .then(() => console.log('Obsidian vault path validated'))
  .catch(error => console.error('Warning:', error.message));

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Middleware
app.use(cors());
app.use(express.json());

// Template management endpoints
app.get('/api/templates/available', async (req, res) => {
  try {
    const templates = await TemplateService.getAvailableTemplates();
    res.json(templates);
  } catch (error) {
    console.error('Error getting available templates:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/templates', async (req, res) => {
  try {
    const { name, content } = req.body;
    
    if (!name || typeof name !== 'string') {
      return res.status(400).json({
        error: 'Invalid input',
        details: ['Template name is required and must be a string']
      });
    }

    if (!content || typeof content !== 'string') {
      return res.status(400).json({
        error: 'Invalid input',
        details: ['Template content is required and must be a string']
      });
    }

    const templatePath = await FileService.saveTemplate(name, content);
    
    // Log template creation
    await logEvent('template_created', {
      name,
      path: templatePath
    });

    res.json({ 
      message: 'Template saved successfully',
      name,
      path: templatePath
    });
  } catch (error) {
    console.error('Error saving template:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/templates', async (req, res) => {
  try {
    const templates = await FileService.listTemplates();
    res.json(templates);
  } catch (error) {
    console.error('Error listing templates:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    version: process.version
  });
});

// Create content endpoint
app.post('/api/content', async (req, res) => {
  try {
    const { title, content, type, metadata = {}, source_url, tags = [] } = req.body;

    // Validate inputs
    if (!title || typeof title !== 'string') {
      return res.status(400).json({ 
        error: 'Invalid input',
        details: ['Title is required and must be a string']
      });
    }

    if (!content || typeof content !== 'string') {
      return res.status(400).json({
        error: 'Invalid input',
        details: ['Content is required and must be a string']
      });
    }

    if (!Array.isArray(tags)) {
      return res.status(400).json({
        error: 'Invalid input',
        details: ['Tags must be an array']
      });
    }

    if (source_url) {
      try {
        new URL(source_url);
      } catch (e) {
        return res.status(400).json({
          error: 'Invalid input',
          details: ['Invalid URL format']
        });
      }
    }

    const { data, error } = await supabase
      .from('content')
      .insert([{
        title,
        content,
        type,
        metadata,
        source_url,
        status: 'draft'
      }])
      .select();

    if (error) throw error;

    // Log content creation
    await logEvent('content_created', {
      content_id: data[0].id,
      type,
      title
    }, data[0].user_id);

    res.json(data[0]);
  } catch (error) {
    console.error('Error creating content:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get content endpoint
app.get('/api/content', async (req, res) => {
  try {
    const { type, status } = req.query;
    let query = supabase.from('content').select('*');

    if (type) query = query.eq('type', type);
    if (status) query = query.eq('status', status);

    const { data, error } = await query;
    if (error) throw error;

    res.json(data);
  } catch (error) {
    console.error('Error fetching content:', error);
    res.status(500).json({ error: error.message });
  }
});

// Scrape content endpoint
app.post('/api/scrape', async (req, res) => {
  try {
    const { url, type = 'blog_post', metadata = {}, tags = [] } = req.body;
    const { template } = req.body;

    // Validate template
    const templates = await TemplateService.getAvailableTemplates();
    const validTemplate = templates.find(t => t.id === template);
    if (template && !validTemplate) {
      return res.status(400).json({ 
        error: 'Invalid template',
        validTemplates: templates.map(t => t.id)
      });
    }

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    if (!Array.isArray(tags)) {
      return res.status(400).json({
        error: 'Invalid input',
        details: ['Tags must be an array']
      });
    }

    // Validate URL format
    try {
      new URL(url);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid URL format' });
    }

    // Log scraping start
    await logEvent('scrape_started', { url, type }, 'system');

    // Scrape content
    const scrapedData = await ScraperService.scrape(url);

    // Save to Supabase
    const { data, error: dbError } = await supabase
      .from('content')
      .insert([{
        title: scrapedData.title,
        content: scrapedData.content,
        type,
        metadata: {
          ...metadata,
          ...scrapedData.metadata,
          tags: [...new Set([...(metadata.tags || []), ...tags])],
          tags,
          scrapeTimestamp: new Date().toISOString()
        },
        source_url: url,
        status: 'draft'
      }])
      .select();

    if (dbError) throw dbError;
    
    // Save as Markdown file
    const markdownContent = await TemplateService.applyTemplate(
      template || 'blog-post',
      data[0]
    );
    const markdownPath = await TemplateService.saveToObsidian(
      markdownContent,
      data[0].metadata.keywords?.[0] || 'uncategorized'
    );
    
    // Update content record with markdown path
    await supabase
      .from('content')
      .update({ 
        metadata: { 
          ...data[0].metadata,
          markdownPath 
        }
      })
      .eq('id', data[0].id);

    // Log scraping event
    await logEvent('content_scraped', {
      content_id: data[0].id,
      url,
      type
    }, data[0].user_id);

    res.json(data[0]);
  } catch (error) {
    // Log scraping error
    await logEvent('scrape_error', {
      url,
      error: error.message
    }, 'system');

    console.error('Error initiating scrape:', error);
    res.status(500).json({ error: error.message });
  }
});

// Helper function to log events
async function logEvent(event, details, user_id) {
  try {
    await supabase
      .from('logs')
      .insert([{
        event,
        details,
        user_id
      }]);
  } catch (error) {
    console.error('Error logging event:', error);
  }
}

// Get logs endpoint
app.get('/api/logs', async (req, res) => {
  try {
    const { event, start_date, end_date } = req.query;
    let query = supabase.from('logs').select('*');

    if (event) query = query.eq('event', event);
    if (start_date) query = query.gte('created_at', start_date);
    if (end_date) query = query.lte('created_at', end_date);

    const { data, error } = await query;
    if (error) throw error;

    res.json(data);
  } catch (error) {
    console.error('Error fetching logs:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create log endpoint
app.post('/api/logs', async (req, res) => {
  try {
    const { event, details = {} } = req.body;
    const { data, error } = await supabase
      .from('logs')
      .insert([{
        event,
        details
      }])
      .select();

    if (error) throw error;
    res.json(data[0]);
  } catch (error) {
    console.error('Error creating log:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get content by URL endpoint
app.get('/api/content/url/:url(*)', async (req, res) => {
  try {
    const url = decodeURIComponent(req.params.url);
    
    const { data, error } = await supabase
      .from('content')
      .select('*')
      .eq('source_url', url)
      .maybeSingle();

    if (error) throw error;
    
    if (!data) {
      return res.status(404).json({ 
        error: 'Content not found',
        message: 'No content found for the provided URL'
      });
    }

    res.json(data);
  } catch (error) {
    console.error('Error fetching content by URL:', error);
    res.status(500).json({ error: error.message });
  }
});

// Start server
app.listen(port, '0.0.0.0', () => {
  console.log(`Server running at http://0.0.0.0:${port}`);
});