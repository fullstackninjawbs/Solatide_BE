import { Router } from 'express';
import { AppError } from '../utils/appError';
import { sendNewsletterWelcomeEmail } from '../services/emailService';
import { NewsletterSubscriber } from '../models/marketing.model';
import { formSubmitLimiter } from '../middleware/rateLimit';

const router = Router();

// Pragmatic email check (RFC 5321 length limits, single @, dotted domain, no spaces/brackets)
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export const isValidEmail = (email: unknown): email is string =>
  typeof email === 'string' && email.length <= 254 && EMAIL_RE.test(email);

router.post('/', formSubmitLimiter, async (req, res, next) => {
    try {
        const raw = req.body?.email;
        if (!raw) {
            return next(new AppError('Email is required', 400));
        }
        const email = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
        if (!isValidEmail(email)) {
            return next(new AppError('Please provide a valid email address', 400));
        }

        // Check if subscriber already exists
        const existingSubscriber = await NewsletterSubscriber.findOne({ email });
        if (existingSubscriber) {
            if (existingSubscriber.status === 'unsubscribed') {
                existingSubscriber.status = 'active';
                await existingSubscriber.save();
                // Send welcome email again if they resubscribe
                try {
                    await sendNewsletterWelcomeEmail(email);
                } catch (emailErr) {
                    console.error('Failed to send welcome email:', emailErr);
                }
                return res.status(200).json({ success: true, message: 'Successfully resubscribed to newsletter' });
            }
            return res.status(200).json({ success: true, message: 'Already subscribed' });
        }

        // Create new subscriber in database
        await NewsletterSubscriber.create({
            email,
            source: 'homepage',
            status: 'active'
        });

        // Send a welcome email to the user via Brevo SMTP
        try {
            await sendNewsletterWelcomeEmail(email);
        } catch (emailErr) {
            console.error('Failed to send welcome email:', emailErr);
        }

        res.status(200).json({
            success: true,
            message: 'Successfully subscribed to newsletter'
        });

    } catch (error) {
        console.error('Subscribe Error:', error);
        next(new AppError('An error occurred during subscription', 500));
    }
});

export default router;
