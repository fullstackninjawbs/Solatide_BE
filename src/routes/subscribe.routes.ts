import { Router } from 'express';
import { AppError } from '../utils/appError';
import { sendNewsletterWelcomeEmail } from '../services/emailService';
import { NewsletterSubscriber } from '../models/marketing.model';

const router = Router();

router.post('/', async (req, res, next) => {
    try {
        const { email } = req.body;
        if (!email) {
            return next(new AppError('Email is required', 400));
        }

        // Check if subscriber already exists
        const existingSubscriber = await NewsletterSubscriber.findOne({ email: email.toLowerCase() });
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
            email: email.toLowerCase(),
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
