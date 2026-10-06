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
        .button-container { text-align: center; margin: 30px 0; color: #FFFFF0 }
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

export const sendOrderConfirmationEmail = async (order: any) => {
  const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
  const orderUrl = `${clientUrl}/order/${order._id}`;
  const companyLogo = 'https://res.cloudinary.com/dmzdud9i/image/upload/v1783360609/assets/yrapi73fs2iodwl7inmg.png';
  const currency = order.currency || 'AUD';

  const formatPrice = (amount: number) => {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
  };

  const country = order.shippingAddressObj?.country || order.shippingAddress?.country || '';
  const isDomesticAU = country.toLowerCase() === 'australia' || country.toUpperCase() === 'AU';
  const displayShippingMethod = order.shippingMethodName || (isDomesticAU
    ? 'Australia Post Express Shipping'
    : 'Standard Shipping');


  const lineItemsHtml = (order.lineItems || []).map((item: any) => `
    <tr>
      <td style="padding: 15px 0; border-bottom: 1px solid #e5e5e5; width: 60px;">
        ${item.productImageUrl ? `<img src="${item.productImageUrl}" style="width: 50px; height: 50px; border-radius: 4px; border: 1px solid #e5e5e5; object-fit: contain;" />` : `<div style="width: 50px; height: 50px; border-radius: 4px; border: 1px solid #e5e5e5; background: #f9f9f9;"></div>`}
      </td>
      <td style="padding: 15px 15px; border-bottom: 1px solid #e5e5e5; text-align: left;">
        <span style="font-weight: 600; color: #333; display: block; font-size: 14px;">${item.title}</span>
        ${item.variantTitle ? `<span style="color: #737373; font-size: 13px; display: block; margin-top: 4px;">${item.variantTitle}</span>` : ''}
        <span style="color: #737373; font-size: 13px; display: block; margin-top: 4px;">Qty: ${item.quantity}</span>
      </td>
      <td style="padding: 15px 0; border-bottom: 1px solid #e5e5e5; text-align: right; color: #333; font-weight: 500; font-size: 14px; vertical-align: top;">
        ${formatPrice(item.subtotal || (item.unitPrice * item.quantity))}
      </td>
    </tr>
  `).join('');

  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Order Confirmation</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background-color: #f5f5f5; margin: 0; padding: 0; -webkit-font-smoothing: antialiased; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px 0; }
        .content { background-color: #ffffff; padding: 40px; border-radius: 0; }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 40px; }
        .logo { max-height: 40px; }
        .order-title { text-align: left; margin-bottom: 30px; }
        h2 { color: #333; font-size: 24px; font-weight: 400; margin: 0 0 10px 0; }
        p { color: #555; font-size: 15px; line-height: 1.5; margin: 0 0 20px 0; }
        .button { background-color: #00bfef; color: #ffffff !important; text-decoration: none; padding: 15px 25px; border-radius: 4px; font-weight: 500; font-size: 15px; display: inline-block; }
        .summary-title { font-size: 16px; color: #333; margin: 40px 0 15px 0; font-weight: 600; border-bottom: 1px solid #e5e5e5; padding-bottom: 15px; }
        table { width: 100%; border-collapse: collapse; }
        .totals-table { width: 100%; border-top: 1px solid #e5e5e5; padding-top: 15px; margin-bottom: 20px; }
        .totals-label { text-align: left; padding: 5px 0; color: #737373; font-size: 14px; }
        .totals-value { text-align: right; padding: 5px 0; font-size: 14px; color: #333; font-weight: 500; }
        .grand-total { font-weight: 700; font-size: 18px; color: #000; border-top: 1px solid #e5e5e5; padding-top: 15px; margin-top: 10px; }
        .customer-info-box { margin-top: 40px; border: 1px solid #e5e5e5; border-radius: 8px; overflow: hidden; }
        @media only screen and (max-width: 600px) {
          .content { padding: 30px 20px; }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div style="padding: 20px 40px;">
          <img src="${companyLogo}" alt="Solatide Biosciences" style="height: 62px;" />
          <span style="float: right; color: #737373; font-size: 13px; padding-top: 10px;">ORDER #${order.orderNumber}</span>
        </div>
        
        <div class="content">
          <div class="order-title">
            <h2>${order.source === 'admin_manual' ? 'Your order has been placed!' : 'Thank you for your order!'}</h2>
            <p>${order.source === 'admin_manual' ? 'We have successfully placed an order on your behalf. We will notify you when it has been sent.' : "We're getting your order ready to be shipped. We will notify you when it has been sent."}</p>
            <a href="${orderUrl}" class="button">View your order</a>
            <span style="color: #00bfef; margin-left: 15px; font-size: 14px;"><a href="${clientUrl}/collections/all" style="color: #00bfef; text-decoration: none;">or Visit our store</a></span>
          </div>
          
          <h3 class="summary-title">Order summary</h3>
          
          <table>
            ${lineItemsHtml}
          </table>
          
          <table class="totals-table">
            <tr>
              <td class="totals-label">Subtotal</td>
              <td class="totals-value">${formatPrice(order.subtotal || 0)}</td>
            </tr>
            <tr>
              <td class="totals-label">Shipping</td>
              <td class="totals-value">${formatPrice(order.shippingAmount || 0)}</td>
            </tr>
            <tr>
              <td class="totals-label">Taxes</td>
              <td class="totals-value">${formatPrice(order.taxAmount || 0)}</td>
            </tr>
            <tr>
              <td class="totals-label grand-total">Total</td>
              <td class="totals-value grand-total">${formatPrice(order.grandTotal || 0)} ${currency}</td>
            </tr>
          </table>

          <div class="customer-info-box">
            <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse;">
              <tr>
                <td style="padding: 15px 20px; border-bottom: 1px solid #e5e5e5; width: 25%; color: #737373; font-size: 13px;">Contact</td>
                <td style="padding: 15px 20px; border-bottom: 1px solid #e5e5e5; color: #333; font-size: 14px;">${order.customerEmail || order.customer?.email}</td>
              </tr>
              <tr>
                <td style="padding: 15px 20px; border-bottom: 1px solid #e5e5e5; width: 25%; color: #737373; font-size: 13px; vertical-align: top;">Ship to</td>
                <td style="padding: 15px 20px; border-bottom: 1px solid #e5e5e5; color: #333; font-size: 14px; line-height: 1.5;">
                  ${order.shippingAddressObj?.name || order.customer?.firstName + ' ' + order.customer?.lastName}<br>
                  ${order.shippingAddressObj?.street1 || ''}<br>
                  ${order.shippingAddressObj?.street2 ? order.shippingAddressObj.street2 + '<br>' : ''}
                  ${order.shippingAddressObj?.city || ''}, ${order.shippingAddressObj?.state || ''} ${order.shippingAddressObj?.zip || ''}<br>
                  ${order.shippingAddressObj?.country || ''}
                </td>
              </tr>
              <tr>
                <td style="padding: 15px 20px; width: 25%; color: #737373; font-size: 13px;">Method</td>
                <td style="padding: 15px 20px; color: #333; font-size: 14px;">${displayShippingMethod}</td>
              </tr>
            </table>
          </div>
        </div>
        
        <div style="text-align: center; color: #999; font-size: 12px; margin-top: 30px;">
          If you have any questions, reply to this email or contact us at <a href="mailto:support@solatide.com" style="color: #00bfef;">support@solatide.com</a>
        </div>
      </div>
    </body>
    </html>
  `;

  const fromName = process.env.SMTP_FROM_NAME || 'Solatide Biosciences';
  const fromEmail = process.env.SMTP_FROM_EMAIL || 'noreply@solatide.com';
  const customerEmail = order.customerEmail || order.customer?.email;

  if (!customerEmail) {
    console.error('No customer email found for order confirmation:', order.orderNumber);
    return;
  }

  const mailOptions = {
    from: `${fromName} <${fromEmail}>`,
    to: customerEmail,
    subject: `Order #${order.orderNumber} confirmed`,
    html,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log('Order confirmation email sent: %s', info.messageId);
  } catch (error) {
    console.error('Error sending order confirmation email:', error);
    throw error;
  }
};

export const sendShipmentConfirmationEmail = async (order: any) => {
  const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
  const orderUrl = `${clientUrl}/order/${order._id}`;
  const companyLogo = 'https://res.cloudinary.com/dmzdud9i/image/upload/v1783360609/assets/yrapi73fs2iodwl7inmg.png';

  const customerName = order.customer?.firstName
    ? `${order.customer.firstName} ${order.customer.lastName || ''}`.trim()
    : (order.customerName || 'Customer');

  const country = order.shippingAddressObj?.country || '';
  const isDomestic = country.toLowerCase() === 'au' || country.toLowerCase() === 'australia';
  const methodName = (order.shippingMethodName || '').toLowerCase();

  let displayMethod = 'Australia Post';
  if (isDomestic) {
    displayMethod = 'Australia Post - Express';
  } else {
    if (methodName.includes('express')) {
      displayMethod = 'Australia Post - International Express';
    } else {
      displayMethod = 'Australia Post - International Standard';
    }
  }

  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Your order has been shipped</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background-color: #f5f5f5; margin: 0; padding: 0; -webkit-font-smoothing: antialiased; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px 0; }
        .content { background-color: #ffffff; padding: 40px; border-radius: 0; }
        h2 { color: #333; font-size: 24px; font-weight: 400; margin: 0 0 10px 0; }
        p { color: #555; font-size: 15px; line-height: 1.5; margin: 0 0 20px 0; }
        .button { background-color: #00bfef; color: #ffffff !important; text-decoration: none; padding: 15px 25px; border-radius: 4px; font-weight: 500; font-size: 15px; display: inline-block; margin-right: 10px; }
        .button-secondary { background-color: #f5f5f5; color: #333 !important; text-decoration: none; padding: 15px 25px; border-radius: 4px; font-weight: 500; font-size: 15px; display: inline-block; border: 1px solid #ddd; }
        .details-box { margin-top: 30px; border: 1px solid #e5e5e5; border-radius: 8px; overflow: hidden; padding: 20px; }
        .detail-row { margin-bottom: 10px; }
        .detail-label { color: #737373; font-size: 13px; display: inline-block; width: 120px; }
        .detail-value { color: #333; font-size: 14px; font-weight: 500; }
      </style>
    </head>
    <body>
      <div class="container">
        <div style="padding: 20px 40px;">
          <img src="${companyLogo}" alt="Solatide Biosciences" style="height: 35px;" />
          <span style="float: right; color: #737373; font-size: 13px; padding-top: 10px;">ORDER #${order.orderNumber}</span>
        </div>
        
        <div class="content">
          <h2>Your order is on the way!</h2>
          <p>Hi ${customerName},</p>
          <p>Great news! Your order <strong>#${order.orderNumber}</strong> has been shipped and is currently on its way to you.</p>
          <p>It can take up to 24 hours for tracking information to become available.</p>
          
          <div style="margin-top: 30px; margin-bottom: 30px;">
            ${order.trackingUrl ? `<a href="${order.trackingUrl}" class="button">Track Shipment</a>` : ''}
            <a href="${orderUrl}" class="button-secondary">View Order</a>
          </div>
          
          <div class="details-box">
            <div class="detail-row">
              <span class="detail-label">Shipping Method:</span>
              <span class="detail-value">${displayMethod}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Tracking Number:</span>
              <span class="detail-value">${order.trackingNumber || 'N/A'}</span>
            </div>
          </div>
        </div>
        
        <div style="text-align: center; color: #999; font-size: 12px; margin-top: 30px;">
          If you have any questions, reply to this email or contact us at <a href="mailto:support@solatide.com" style="color: #00bfef;">support@solatide.com</a>
        </div>
      </div>
    </body>
    </html>
  `;

  const fromName = process.env.SMTP_FROM_NAME || 'Solatide Biosciences';
  const fromEmail = process.env.SMTP_FROM_EMAIL || 'noreply@solatide.com';
  const customerEmail = order.customerEmail || order.customer?.email;

  if (!customerEmail) {
    console.error('No customer email found for shipment confirmation:', order.orderNumber);
    return;
  }

  const mailOptions = {
    from: `${fromName} <${fromEmail}>`,
    to: customerEmail,
    subject: `Your order #${order.orderNumber} has been shipped`,
    html,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log('Shipment confirmation email sent: %s', info.messageId);
  } catch (error) {
    console.error('Error sending shipment confirmation email:', error);
    throw error;
  }
};

export const sendResetPasswordEmail = async (email: string, resetToken: string, name: string) => {
  const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
  const resetUrl = `${clientUrl}/admin/reset-password/${resetToken}`;
  const companyLogo = 'https://res.cloudinary.com/dmzdud9i/image/upload/v1783360609/assets/yrapi73fs2iodwl7inmg.png';

  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Reset Your Password</title>
      <style>
        body { font-family: sans-serif; background-color: #f6f6f6; margin: 0; padding: 0; }
        .container { max-width: 600px; margin: 40px auto; background-color: #ffffff; padding: 40px 30px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); }
        .header { text-align: center; margin-bottom: 30px; }
        .logo { max-height: 40px; }
        h2 { color: #333; font-size: 24px; margin-bottom: 20px; text-align: center; }
        p { color: #555; font-size: 15px; line-height: 1.6; margin-bottom: 20px; }
        .button-container { text-align: center; margin: 30px 0; }
        .button { background-color: #214A9E; color: #ffffff; text-decoration: none; padding: 14px 28px; border-radius: 8px; font-weight: 600; font-size: 16px; display: inline-block; }
        .footer { text-align: center; margin-top: 40px; color: #9ca3af; font-size: 12px; border-top: 1px solid #f3f4f6; padding-top: 20px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <img src="${companyLogo}" alt="Solatide Biosciences" class="logo" />
        </div>
        
        <h2>Password Reset Request</h2>
        <p>Hi ${name},</p>
        <p>You requested to reset your password for the Solatide Biosciences Admin Portal. Click the button below to set a new password. This link is only valid for 10 minutes.</p>

        <div class="button-container">
          <a href="${resetUrl}" class="button" style="color: #ffffff;">Reset Password</a>
        </div>

        <p>If you didn't request a password reset, you can safely ignore this email. Your password will remain unchanged.</p>

        <div class="footer">
          Solatide Biosciences Admin Portal &copy; ${new Date().getFullYear()}
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
    subject: `Password Reset Link - Solatide Biosciences`,
    html,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Password reset email sent to ${email}`);
  } catch (error) {
    console.error('Error sending reset email:', error);
    throw error;
  }
};

export const sendNewsletterWelcomeEmail = async (email: string) => {
  const companyLogo = 'https://res.cloudinary.com/dmzdud9i/image/upload/v1783360609/assets/yrapi73fs2iodwl7inmg.png';
  const clientUrl = process.env.CLIENT_URL ? process.env.CLIENT_URL.split(',')[0].trim() : 'http://localhost:5173';
  const shopUrl = `${clientUrl}/shop`;

  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>Welcome to Solatide Biosciences!</title>
      <style>
        body { font-family: sans-serif; background-color: #f6f6f6; margin: 0; padding: 0; }
        .container { max-width: 600px; margin: 40px auto; background-color: #ffffff; padding: 40px 30px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); }
        .header { text-align: center; margin-bottom: 30px; }
        .logo { max-height: 40px; }
        h2 { color: #333; font-size: 24px; margin-bottom: 20px; text-align: center; }
        p { color: #555; font-size: 15px; line-height: 1.6; margin-bottom: 20px; text-align: center; }
        .button-container { text-align: center; margin: 30px 0; }
        .button { background-color: #0079CE; color: #ffffff; text-decoration: none; padding: 14px 28px; border-radius: 4px; font-weight: 600; font-size: 16px; display: inline-block; }
        .footer { text-align: center; margin-top: 40px; color: #9ca3af; font-size: 12px; border-top: 1px solid #f3f4f6; padding-top: 20px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <img src="${companyLogo}" alt="Solatide Biosciences" class="logo" />
        </div>
        <h2>Welcome to Solatide Biosciences!</h2>
        <p>Thank you for subscribing to our newsletter.</p>
        <p>You'll now be the first to know about our latest product releases, restocks, and exclusive research updates.</p>
        <div class="button-container">
          <a href="${shopUrl}" class="button" style="color: #ffffff !important;">Browse Peptides</a>
        </div>
        <div class="footer">
          <p>© ${new Date().getFullYear()} Solatide Biosciences. All rights reserved.</p>
          <p>For in-vitro laboratory research use only.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  await transporter.sendMail({
    from: `"${process.env.SMTP_FROM_NAME || 'Solatide Biosciences'}" <${process.env.SMTP_FROM_EMAIL}>`,
    to: email,
    subject: 'Welcome to Solatide Biosciences!',
    html,
  });
};

export const sendAdminNewOrderNotificationEmail = async (order: any) => {
  const adminNotificationEmail = process.env.ADMIN_NOTIFICATION_EMAIL || 'contact@solatidebiosciences.com.au';
  if (!adminNotificationEmail) {
    console.log('[Admin Email] No admin notification email configured. Skipping.');
    return;
  }

  const clientUrl = process.env.CLIENT_URL || 'https://solatidebiosciences.com.au';
  const adminOrderUrl = `${clientUrl}/admin/orders/${order._id}`;
  const companyLogo = 'https://res.cloudinary.com/dmzdud9i/image/upload/v1783360609/assets/yrapi73fs2iodwl7inmg.png';
  const currency = order.currency || 'AUD';

  const formatPrice = (amount: number) => {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
  };

  const customerName = order.customerName || (order.customer?.firstName ? `${order.customer.firstName} ${order.customer.lastName || ''}`.trim() : (order.shippingAddressObj?.name || 'Customer'));
  const customerEmail = order.customerEmail || order.customer?.email || 'N/A';
  const customerPhone = order.customer?.phone || (order.shippingAddressObj as any)?.phone || (order.billingAddressObj as any)?.phone || 'Not provided';

  const country = order.shippingAddressObj?.country || order.shippingAddress?.country || '';
  const isDomesticAU = country.toLowerCase() === 'australia' || country.toUpperCase() === 'AU';
  const displayShippingMethod = order.shippingMethodName || (isDomesticAU ? 'Australia Post Express Shipping' : 'Standard Shipping');

  const lineItemsHtml = (order.lineItems || []).map((item: any) => `
    <tr>
      <td style="padding: 12px 0; border-bottom: 1px solid #e2e8f0; width: 55px;">
        ${item.productImageUrl ? `<img src="${item.productImageUrl}" style="width: 45px; height: 45px; border-radius: 4px; border: 1px solid #e2e8f0; object-fit: contain;" />` : `<div style="width: 45px; height: 45px; border-radius: 4px; border: 1px solid #e2e8f0; background: #f8fafc;"></div>`}
      </td>
      <td style="padding: 12px 15px; border-bottom: 1px solid #e2e8f0; text-align: left;">
        <span style="font-weight: 600; color: #1e293b; display: block; font-size: 14px;">${item.title}</span>
        ${item.variantTitle ? `<span style="color: #64748b; font-size: 13px; display: block; margin-top: 2px;">${item.variantTitle}</span>` : ''}
        <span style="color: #64748b; font-size: 13px; display: block; margin-top: 2px;">Qty: ${item.quantity} ${item.sku ? `(SKU: ${item.sku})` : ''}</span>
      </td>
      <td style="padding: 12px 0; border-bottom: 1px solid #e2e8f0; text-align: right; color: #1e293b; font-weight: 600; font-size: 14px; vertical-align: top;">
        ${formatPrice(item.subtotal || (item.unitPrice * item.quantity))}
      </td>
    </tr>
  `).join('');

  const shippingAddrHtml = order.shippingAddressObj ? `
    ${order.shippingAddressObj.name || customerName}<br>
    ${order.shippingAddressObj.street1 || ''}<br>
    ${order.shippingAddressObj.street2 ? order.shippingAddressObj.street2 + '<br>' : ''}
    ${order.shippingAddressObj.city || ''}, ${order.shippingAddressObj.state || ''} ${order.shippingAddressObj.zip || ''}<br>
    ${order.shippingAddressObj.country || 'AU'}
  ` : (order.shippingAddress || 'Not specified');

  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>New Order Notification #${order.orderNumber}</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background-color: #f1f5f9; margin: 0; padding: 0; -webkit-font-smoothing: antialiased; }
        .container { max-width: 600px; margin: 25px auto; padding: 0 10px; }
        .card { background-color: #ffffff; padding: 35px 35px 40px 35px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
        .badge { background-color: #ecfdf5; color: #047857; font-size: 12px; font-weight: 700; padding: 4px 10px; border-radius: 9999px; text-transform: uppercase; letter-spacing: 0.5px; display: inline-block; }
        .button { background-color: #1e40af; color: #ffffff !important; text-decoration: none; padding: 14px 28px; border-radius: 6px; font-weight: 600; font-size: 15px; display: inline-block; }
        table { width: 100%; border-collapse: collapse; }
        .totals-table { width: 100%; border-top: 1px solid #e2e8f0; margin-top: 15px; margin-bottom: 25px; }
        .totals-label { text-align: left; padding: 6px 0; color: #64748b; font-size: 14px; }
        .totals-value { text-align: right; padding: 6px 0; font-size: 14px; color: #1e293b; font-weight: 600; }
        .grand-total { font-weight: 800; font-size: 18px; color: #0f172a; border-top: 2px solid #0f172a; padding-top: 12px; margin-top: 8px; }
        .info-card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; margin-top: 25px; overflow: hidden; }
        .info-cell { padding: 12px 16px; border-bottom: 1px solid #e2e8f0; font-size: 13.5px; }
        .info-label { width: 30%; color: #64748b; font-weight: 600; vertical-align: top; }
        .info-value { color: #0f172a; line-height: 1.5; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="card">
          <div style="border-bottom: 1px solid #e2e8f0; padding-bottom: 20px; margin-bottom: 25px;">
            <table width="100%">
              <tr>
                <td><img src="${companyLogo}" alt="Solatide Biosciences" style="height: 50px;" /></td>
                <td style="text-align: right;">
                  <span class="badge">Paid • ${order.paymentMethod === 'tagada' ? 'TagadaPay' : (order.paymentMethod || 'Online')}</span>
                  <div style="color: #64748b; font-size: 13px; font-weight: 600; margin-top: 6px;">ORDER #${order.orderNumber}</div>
                </td>
              </tr>
            </table>
          </div>

          <h2 style="color: #0f172a; font-size: 22px; font-weight: 700; margin: 0 0 8px 0;">New Order Placed! 🎉</h2>
          <p style="color: #475569; font-size: 14.5px; line-height: 1.5; margin: 0 0 25px 0;">
            A new order has been placed on <strong>Solatide Biosciences</strong>. Review the details below or view it in the admin dashboard to manage shipment.
          </p>

          <div style="margin: 25px 0 35px 0; text-align: center;">
            <a href="${adminOrderUrl}" class="button">View Order in Admin Hub →</a>
          </div>

          <h3 style="font-size: 15px; color: #0f172a; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; margin: 30px 0 12px 0; border-bottom: 1px solid #e2e8f0; padding-bottom: 8px;">Order Summary</h3>
          <table>
            ${lineItemsHtml}
          </table>

          <table class="totals-table">
            <tr>
              <td class="totals-label">Subtotal</td>
              <td class="totals-value">${formatPrice(order.subtotal || 0)}</td>
            </tr>
            ${order.discountAmount ? `
            <tr>
              <td class="totals-label">Discount ${order.couponCode ? `(${order.couponCode})` : ''}</td>
              <td class="totals-value" style="color: #16a34a;">-${formatPrice(order.discountAmount)}</td>
            </tr>` : ''}
            <tr>
              <td class="totals-label">Shipping</td>
              <td class="totals-value">${formatPrice(order.shippingAmount || 0)}</td>
            </tr>
            <tr>
              <td class="totals-label grand-total">Total Amount</td>
              <td class="totals-value grand-total">${formatPrice(order.grandTotal || order.totalAmount || 0)} ${currency}</td>
            </tr>
          </table>

          <h3 style="font-size: 15px; color: #0f172a; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; margin: 30px 0 12px 0; border-bottom: 1px solid #e2e8f0; padding-bottom: 8px;">Customer & Delivery Details</h3>
          <div class="info-card">
            <table>
              <tr>
                <td class="info-cell info-label">Customer</td>
                <td class="info-cell info-value"><strong>${customerName}</strong></td>
              </tr>
              <tr>
                <td class="info-cell info-label">Email</td>
                <td class="info-cell info-value"><a href="mailto:${customerEmail}" style="color: #2563eb; text-decoration: none;">${customerEmail}</a></td>
              </tr>
              <tr>
                <td class="info-cell info-label">Phone</td>
                <td class="info-cell info-value"><strong>${customerPhone}</strong></td>
              </tr>
              <tr>
                <td class="info-cell info-label">Ship To</td>
                <td class="info-cell info-value">${shippingAddrHtml}</td>
              </tr>
              <tr>
                <td class="info-cell info-label" style="border-bottom: none;">Shipping Method</td>
                <td class="info-cell info-value" style="border-bottom: none;">${displayShippingMethod}</td>
              </tr>
            </table>
          </div>

          <div style="text-align: center; margin-top: 35px;">
            <a href="${adminOrderUrl}" style="color: #2563eb; font-size: 13.5px; font-weight: 600; text-decoration: none;">Open #${order.orderNumber} in Solatide Admin →</a>
          </div>
        </div>

        <div style="text-align: center; color: #94a3b8; font-size: 12px; margin-top: 20px;">
          Solatide Biosciences Admin Notification • Sent to ${adminNotificationEmail}
        </div>
      </div>
    </body>
    </html>
  `;

  const fromName = process.env.SMTP_FROM_NAME || 'Solatide Biosciences';
  const fromEmail = process.env.SMTP_FROM_EMAIL || 'noreply@solatide.com';

  const mailOptions = {
    from: `"${fromName}" <${fromEmail}>`,
    to: adminNotificationEmail,
    subject: `🛒 New Order: #${order.orderNumber} - ${customerName} (${formatPrice(order.grandTotal || order.totalAmount || 0)})`,
    html,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log('[Admin Email] New order notification email sent to %s: %s', adminNotificationEmail, info.messageId);
  } catch (error) {
    console.error('[Admin Email] Error sending admin order notification email:', error);
  }
};

