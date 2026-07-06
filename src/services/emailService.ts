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

export const sendOrderConfirmationEmail = async (order: any) => {
  const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
  const orderUrl = `${clientUrl}/order/${order._id}`;
  const companyLogo = 'https://res.cloudinary.com/dmzdud9i/image/upload/v1783360609/assets/yrapi73fs2iodwl7inmg.png';
  const currency = order.currency || 'USD';

  const formatPrice = (amount: number) => {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
  };

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
          <img src="${companyLogo}" alt="Solatide Biosciences" style="height: 35px;" />
          <span style="float: right; color: #737373; font-size: 13px; padding-top: 10px;">ORDER ${order.orderNumber}</span>
        </div>
        
        <div class="content">
          <div class="order-title">
            <h2>Thank you for your order!</h2>
            <p>We're getting your order ready to be shipped. We will notify you when it has been sent.</p>
            <a href="${orderUrl}" class="button">View your order</a>
            <span style="color: #00bfef; margin-left: 15px; font-size: 14px;"><a href="${clientUrl}/shop" style="color: #00bfef; text-decoration: none;">or Visit our store</a></span>
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
                <td style="padding: 15px 20px; color: #333; font-size: 14px;">${order.shippingMethodName || 'Standard Shipping'}</td>
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
    subject: `Order ${order.orderNumber} confirmed`,
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

