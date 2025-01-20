import { createClient } from '@supabase/supabase-js';
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import { FileService } from './services/file-service.js';
import { ScraperService } from './services/scraper.js';
import { TemplateService } from './services/template-service.js';

// Load environment variables
dotenv.config();

// Initialize Express app
const app = express();
const port = process.env.PORT || 3000;

// Initialize Supabase client
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  throw new Error('Supabase environment variables are missing.');
}
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// Middleware
app.use(cors());
app.use(express.json());

// Validate Obsidian vault path on startup
(async () => {
  try {
    await FileService.validateVaultPath();
    console.log('Obsidian vault path validated');
  } catch (error) {
    console.error('Warning:', error.message);
  }
})();

// Helper function to log events
async function logEvent(event, details = {}, userId = 'system') {
  try {
    await supabase.from('logs').insert([{ event, details, user_id: userId }]);
  } catch (error) {
    console.error('Error logging event:', error);
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    version: process.version,
  });
});

// Template management endpoints
app.get('/api/templates/available', async (req, res) => {
  try {
    const templates = await TemplateService.getAvailableTemplates();
    res.json(templates);
  } catch (error) {
    console.error('Error getting available templates:', error);
    res.status(500).json({ error: 'Failed to fetch templates.' });
  }
});

app.post('/api/templates', async (req, res) => {
  try {
    const { name, content } = req.body;

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'Template name is required and must be a string.' });
    }
    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'Template content is required and must be a string.' });
    }

    const templatePath = await FileService.saveTemplate(name, content);
    await logEvent('template_created', { name, path: templatePath });

    res.json({ message: 'Template saved successfully', name, path: templatePath });
  } catch (error) {
    console.error('Error saving template:', error);
    res.status(500).json({ error: 'Failed to save template.' });
  }
});

app.get('/api/templates', async (req, res) => {
  try {
    const templates = await FileService.listTemplates();
    res.json(templates);
  } catch (error) {
    console.error('Error listing templates:', error);
    res.status(500).json({ error: 'Failed to list templates.' });
  }
});

// Content creation endpoints
app.post('/api/content', async (req, res) => {
  try {
    const { title, content, type, metadata = {}, source_url, tags = [] } = req.body;

    if (!title || typeof title !== 'string') {
      return res.status(400).json({ error: 'Title is required and must be a string.' });
    }
    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'Content is required and must be a string.' });
    }
    if (!Array.isArray(tags)) {
      return res.status(400).json({ error: 'Tags must be an array.' });
    }

    const { data, error } = await supabase.from('content').insert([{ title, content, type, metadata, source_url, status: 'draft' }]).select();
    if (error) throw error;

    await logEvent('content_created', { content_id: data[0].id, type, title });

    res.json(data[0]);
  } catch (error) {
    console.error('Error creating content:', error);
    res.status(500).json({ error: 'Failed to create content.' });
  }
});

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
    res.status(500).json({ error: 'Failed to fetch content.' });
  }
});

// Scrape content endpoint
app.post('/api/scrape', async (req, res) => {
  try {
    const { url, type = 'blog_post', metadata = {}, tags = [], template } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'URL is required.' });
    }
    try {
      new URL(url); // Validate URL format
    } catch {
      return res.status(400).json({ error: 'Invalid URL format.' });
    }

    const templates = await TemplateService.getAvailableTemplates();
    const validTemplate = templates.find((t) => t.id === template);
    if (template && !validTemplate) {
      return res.status(400).json({ error: 'Invalid template.', validTemplates: templates.map((t) => t.id) });
    }

    await logEvent('scrape_started', { url, type });

    // Scrape content
    const scrapedData = await ScraperService.scrape(url);

    const { data, error } = await supabase.from('content').insert([{
      title: scrapedData.title,
      content: scrapedData.content,
      type,
      metadata: { ...metadata, ...scrapedData.metadata, tags },
      source_url: url,
      status: 'draft',
    }]).select();
    if (error) throw error;

    const markdownContent = await TemplateService.applyTemplate(template || 'blog-post', data[0]);
    const markdownPath = await TemplateService.saveToObsidian(markdownContent, data[0].metadata.keywords?.[0] || 'uncategorized');

    await supabase.from('content').update({ metadata: { ...data[0].metadata, markdownPath } }).eq('id', data[0].id);

    await logEvent('content_scraped', { content_id: data[0].id, url, type });

    res.json(data[0]);
  } catch (error) {
    console.error('Error scraping content:', error);
    res.status(500).json({ error: 'Failed to scrape content.' });
  }
});

// Logs endpoints
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
    res.status(500).json({ error: 'Failed to fetch logs.' });
  }
});

// Start server
app.listen(port, () => {
  console.log(`Server running at http://0.0.0.0:${port}`);
});
