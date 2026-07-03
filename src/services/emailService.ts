import { transporter } from '../config/email';

export const sendVerificationEmail = async (
  email: string,
  reviewerName: string,
  productName: string,
  productImage: string,
  rating: number,
  reviewTitle: string,
  reviewContent: string,
  verificationToken: string
) => {
  const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
  const verificationUrl = `${clientUrl}/review/verify/${verificationToken}`;
  const companyLogo = 'https://i.imgur.com/uC00Jid.png';

  const starsHtml = '★'.repeat(rating) + '☆'.repeat(5 - rating);

  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Verify Your Email</title>
      <style>
        body { font-family: sans-serif; background-color: #f6f6f6; margin: 0; padding: 0; }
        .container { max-width: 600px; margin: 40px auto; background-color: #ffffff; padding: 40px 30px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); }
        .header { text-align: center; margin-bottom: 30px; }
        .logo { max-height: 40px; }
        h2 { color: #333; font-size: 24px; margin-bottom: 20px; text-align: center; }
        p { color: #555; font-size: 15px; line-height: 1.6; margin-bottom: 20px; }
        .review-box { background-color: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin-bottom: 30px; }
        .product-info { display: flex; align-items: center; margin-bottom: 15px; border-bottom: 1px solid #e5e7eb; padding-bottom: 15px; }
        .product-image { width: 50px; height: 50px; border-radius: 4px; object-fit: cover; margin-right: 15px; }
        .product-name { font-weight: 600; color: #111; margin: 0; font-size: 16px; }
        .stars { color: #fbbf24; font-size: 18px; margin: 0 0 10px 0; letter-spacing: 2px; }
        .review-title { font-weight: 600; color: #111; margin: 0 0 5px 0; font-size: 15px; }
        .review-content { color: #4b5563; font-size: 14px; margin: 0; white-space: pre-wrap; }
        .button-container { text-align: center; margin: 30px 0; }
        .button { background-color: #008060; color: #ffffff; text-decoration: none; padding: 14px 28px; border-radius: 4px; font-weight: 600; font-size: 16px; display: inline-block; }
        .footer { text-align: center; margin-top: 40px; color: #9ca3af; font-size: 12px; border-top: 1px solid #f3f4f6; padding-top: 20px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <img src="${companyLogo}" alt="${process.env.SMTP_FROM_NAME || 'Solatide Biosciences'}" class="logo" />
        </div>
        
        <h2>Verify Your Email</h2>
        <p>Hi ${reviewerName},</p>
        <p>Please verify your email address to confirm that you submitted this review.</p>
        
        <div class="review-box">
          <div class="product-info">
            ${productImage ? `<img src="${productImage}" alt="${productName}" class="product-image" />` : ''}
            <p class="product-name">${productName}</p>
          </div>
          <p class="stars">${starsHtml}</p>
          ${reviewTitle ? `<p class="review-title">${reviewTitle}</p>` : ''}
          <p class="review-content">"${reviewContent}"</p>
        </div>

        <div class="button-container">
          <a href="${verificationUrl}" class="button" style="color: #ffffff;">Verify My Review</a>
        </div>

        <div class="footer">
          If you didn't submit this review, simply ignore this email.
        </div>
      </div>
    </body>
    </html>
  `;

  const fromName = process.env.SMTP_FROM_NAME || 'Solatide Biosciences';
  const fromEmail = process.env.SMTP_FROM_EMAIL || 'noreply@solatide.com';

  const mailOptions = {
    from: `${fromName} <${fromEmail}>`,
    to: email,
    subject: `Verify your review for ${productName}`,
    html,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log('Verification email sent: %s', info.messageId);
  } catch (error) {
    console.error('Error sending verification email:', error);
    throw error;
  }
};
