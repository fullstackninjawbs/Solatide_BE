import { Request, Response } from 'express';
import sanitizeHtml from 'sanitize-html';
import Page from '../models/Page';

// Helper to sanitize HTML content
const sanitizePageContent = (html: string) => {
  return sanitizeHtml(html, {
    allowedTags: [
      'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'u', 's', 'a', 'ul', 'ol', 'li', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'blockquote', 'hr', 'pre', 'code', 'br', 'span', 'div'
    ],
    allowedAttributes: {
      'a': ['href', 'name', 'target', 'rel'],
      'img': ['src', 'alt', 'title', 'width', 'height'],
      '*': ['class', 'id', 'style'] // allow some styling
    },
    allowedStyles: {
      '*': {
        'color': [/^.*$/],
        'text-align': [/^.*$/],
        'background-color': [/^.*$/],
        'padding': [/^.*$/],
        'margin': [/^.*$/],
        'border': [/^.*$/]
      }
    },
    allowProtocolRelative: false
  });
};

const reservedHandles = [
  'admin', 'product', 'products', 'cart', 'checkout', 'login',
  'register', 'account', 'search', 'collections', 'page', 'api'
];

/**
 * ADMIN: Get all pages
 */
export const getAllPages = async (req: Request, res: Response): Promise<void> => {
  try {
    const { search, status } = req.query;
    let query: any = {};

    if (search) {
      query.$or = [
        { title: { $regex: search, $options: 'i' } },
        { slug: { $regex: search, $options: 'i' } }
      ];
    }
    if (status && status !== 'all') {
      query.status = status;
    }

    const pages = await Page.find(query).sort({ updatedAt: -1 });
    res.json(pages);
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * ADMIN: Get single page by ID
 */
export const getPageById = async (req: Request, res: Response): Promise<void> => {
  try {
    const page = await Page.findById(req.params.id);
    if (!page) {
      res.status(404).json({ message: 'Page not found' });
      return;
    }
    res.json(page);
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * ADMIN: Create new page
 */
export const createPage = async (req: Request, res: Response): Promise<void> => {
  try {
    const { title, slug, content, seoTitle, metaDescription, status } = req.body;
    
    if (!title || !slug) {
      res.status(400).json({ message: 'Title and URL handle are required.' });
      return;
    }

    if (reservedHandles.includes(slug.toLowerCase())) {
      res.status(400).json({ message: 'This URL handle is reserved and cannot be used.' });
      return;
    }

    const existingPage = await Page.findOne({ slug });
    if (existingPage) {
      res.status(400).json({ message: 'This URL handle is already in use.' });
      return;
    }

    const sanitizedHtml = content?.html ? sanitizePageContent(content.html) : '';

    const newPage = new Page({
      title,
      slug,
      content: {
        html: sanitizedHtml,
        json: content?.json || null
      },
      seoTitle,
      metaDescription,
      status: status || 'draft',
      publishedAt: status === 'published' ? new Date() : null,
      createdBy: (req as any).user?._id
    });

    await newPage.save();
    res.status(201).json(newPage);
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * ADMIN: Update page
 */
export const updatePage = async (req: Request, res: Response): Promise<void> => {
  try {
    const { title, slug, content, seoTitle, metaDescription, status } = req.body;
    
    const page = await Page.findById(req.params.id);
    if (!page) {
      res.status(404).json({ message: 'Page not found' });
      return;
    }

    if (slug && slug !== page.slug) {
      if (reservedHandles.includes(slug.toLowerCase())) {
        res.status(400).json({ message: 'This URL handle is reserved and cannot be used.' });
        return;
      }
      const existingPage = await Page.findOne({ slug });
      if (existingPage) {
        res.status(400).json({ message: 'This URL handle is already in use.' });
        return;
      }
      
      // Save old slug to history for redirects
      if (!page.slugHistory.includes(page.slug)) {
        page.slugHistory.push(page.slug);
      }
      page.slug = slug;
    }

    if (title !== undefined) page.title = title;
    if (seoTitle !== undefined) page.seoTitle = seoTitle;
    if (metaDescription !== undefined) page.metaDescription = metaDescription;
    
    if (status !== undefined) {
      page.status = status;
      if (status === 'published' && !page.publishedAt) {
        page.publishedAt = new Date();
      }
    }

    if (content) {
      if (content.html !== undefined) {
        page.content.html = sanitizePageContent(content.html);
      }
      if (content.json !== undefined) {
        page.content.json = content.json;
      }
    }

    page.updatedBy = (req as any).user?._id;
    await page.save();

    res.json(page);
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * ADMIN: Delete page
 */
export const deletePage = async (req: Request, res: Response): Promise<void> => {
  try {
    const page = await Page.findByIdAndDelete(req.params.id);
    if (!page) {
      res.status(404).json({ message: 'Page not found' });
      return;
    }
    res.json({ message: 'Page deleted successfully' });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * PUBLIC: Get published page by slug
 */
export const getPageBySlug = async (req: Request, res: Response): Promise<void> => {
  try {
    const { slug } = req.params;
    
    // First, try finding an exact match
    let page = await Page.findOne({ slug });
    let isRedirect = false;

    // If not found, check if this slug is in the history of any page
    if (!page) {
      page = await Page.findOne({ slugHistory: slug });
      if (page) {
        isRedirect = true;
      }
    }

    if (!page || page.status !== 'published') {
      res.status(404).json({ message: 'Page not found' });
      return;
    }

    // If we matched based on history, instruct the frontend to redirect
    if (isRedirect) {
      res.status(301).json({ 
        redirect: true, 
        targetSlug: page.slug 
      });
      return;
    }

    res.json(page);
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};
