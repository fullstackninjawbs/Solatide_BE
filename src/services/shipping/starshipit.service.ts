import axios from 'axios';
import { IOrder } from '../../models/order.model';
import dotenv from 'dotenv';

dotenv.config();

function parseStarshipitError(data: any, fallback: string): string {
  if (!data) return fallback;
  let rawMsg = fallback;
  if (Array.isArray(data.errors) && data.errors.length > 0) {
    const errs = data.errors.map((e: any) => {
      if (typeof e === 'string') return e;
      if (e && typeof e === 'object') {
        return e.details || e.message || JSON.stringify(e);
      }
      return String(e);
    }).filter(Boolean);
    if (errs.length > 0) rawMsg = errs.join('; ');
  } else if (data.validation_errors) {
    if (Array.isArray(data.validation_errors) && data.validation_errors.length > 0) {
      const errs = data.validation_errors.map((ve: any) => {
        if (typeof ve === 'string') return ve;
        return ve.details || ve.message || ve.error || (ve.field ? `${ve.field}: ${ve.message || ve.error}` : JSON.stringify(ve));
      }).filter(Boolean);
      if (errs.length > 0) rawMsg = errs.join('; ');
    } else {
      rawMsg = typeof data.validation_errors === 'string' ? data.validation_errors : JSON.stringify(data.validation_errors);
    }
  } else if (typeof data.details === 'string' && data.details.trim()) {
    rawMsg = data.details;
  } else if (typeof data.message === 'string' && data.message.trim()) {
    rawMsg = data.message;
  } else if (typeof data.error === 'string' && data.error.trim()) {
    rawMsg = data.error;
  } else if (typeof data.error_message === 'string' && data.error_message.trim()) {
    rawMsg = data.error_message;
  }

  if (rawMsg.includes('Unable to get order details from order_id') || rawMsg.includes('Unable to get order details')) {
    return 'Destination address or country is unconfigured in Starshipit. Update shipping address or enable international courier in Starshipit.';
  }

  return rawMsg;
}

export class StarshipitService {
  private readonly baseUrl = 'https://api.starshipit.com/api';

  private get headers() {
    const apiKey = process.env.STARSHIPIT_API_KEY;
    const subscriptionKey = process.env.STARSHIPIT_SUBSCRIPTION_KEY;

    if (!apiKey || !subscriptionKey) {
      console.warn('WARNING: Starshipit API keys are not fully configured.');
    }

    return {
      'StarShipIT-Api-Key': apiKey || '',
      'Ocp-Apim-Subscription-Key': subscriptionKey || '',
      'Content-Type': 'application/json'
    };
  }

  public async createShipment({ order, origin, weightKg }: { order: IOrder, origin: any, weightKg: number }): Promise<{
    orderId: string;
    trackingNumber?: string;
    trackingCarrier?: string;
    labelUrl?: string;
    warning?: string;
  }> {
    const itemsCount = order.lineItems?.length || 1;
    const weightPerItem = weightKg / itemsCount;

    const street = order.shippingAddressObj?.street1 || (typeof order.shippingAddress === 'string' ? order.shippingAddress : undefined);
    const suburb = order.shippingAddressObj?.city || order.shippingAddressObj?.street2;
    const city = order.shippingAddressObj?.city;
    const state = order.shippingAddressObj?.state;
    const postCode = order.shippingAddressObj?.zip;
    const country = order.shippingAddressObj?.country || 'AU';

    const payload = {
      order_date: new Date().toISOString(),
      order_number: order.orderNumber || order._id?.toString(),
      reference: order.orderNumber || order._id?.toString(),
      sender_details: {
        name: 'SB Fulfilment',
        company: 'SB Fulfilment'
      },
      destination: {
        name: order.shippingAddressObj?.name || (order.customer?.firstName ? `${order.customer.firstName} ${order.customer.lastName || ''}`.trim() : 'Customer'),
        company: order.shippingAddressObj?.company,
        street: street,
        suburb: suburb,
        city: city,
        state: state,
        post_code: postCode,
        country: country,
        phone: order.customer?.phone || '',
        email: order.customer?.email || order.customerEmail || ''
      },
      items: (order.lineItems && order.lineItems.length > 0)
        ? order.lineItems.map(item => ({
          description: item.title,
          sku: item.sku || 'UNKNOWN',
          quantity: item.quantity,
          weight: weightPerItem,
          value: item.unitPrice
        }))
        : [{
          description: 'Order Items',
          sku: 'MIXED',
          quantity: 1,
          weight: weightKg,
          value: order.subtotal || 0
        }]
    };

    try {
      console.log('Sending payload to Starshipit /orders:', JSON.stringify(payload, null, 2));
      const response = await axios.post(`${this.baseUrl}/orders`, { order: payload }, { headers: this.headers });
      
      console.log('Starshipit POST /orders HTTP Status:', response.status);
      console.log('Starshipit POST /orders Response Data:', JSON.stringify(response.data, null, 2));

      // Handle soft failures (HTTP 200 but success = false)
      if (response.data && response.data.success === false) {
        const errMsg = parseStarshipitError(response.data, 'Starshipit API returned success=false');
        console.error('Starshipit returned soft failure. Detail:', errMsg);
        throw new Error(errMsg);
      }

      const starshipitOrder = response.data?.order;
      if (!starshipitOrder || !starshipitOrder.order_id) {
        throw new Error('Invalid response from Starshipit API: Missing order_id');
      }

      let trackingNumber = starshipitOrder.tracking_number || '';
      let trackingCarrier = starshipitOrder.carrier || '';
      let labelUrl = '';

      try {
        console.log(`Calling POST /orders/shipment for order_id: ${starshipitOrder.order_id}`);
        const labelResponse = await axios.post(`${this.baseUrl}/orders/shipment`, {
          order_id: starshipitOrder.order_id
        }, { headers: this.headers });
        
        console.log('Starshipit POST /orders/shipment HTTP Status:', labelResponse.status);
        console.log('Starshipit POST /orders/shipment Response Data:', JSON.stringify(labelResponse.data, null, 2));

        if (labelResponse.data && labelResponse.data.success === false) {
          const labelErrMsg = parseStarshipitError(labelResponse.data, 'Label generation failed in Starshipit');
          throw new Error(labelErrMsg);
        }

        const shippedOrder = labelResponse.data?.order || labelResponse.data?.orders?.[0];
        if (shippedOrder) {
          trackingNumber = trackingNumber || shippedOrder.tracking_number || '';
          trackingCarrier = trackingCarrier || shippedOrder.carrier || '';
          labelUrl = shippedOrder.label_url || shippedOrder.pdf_url || shippedOrder.tracking_url || labelUrl;
        } else if (labelResponse.data && labelResponse.data.labels && labelResponse.data.labels.length > 0) {
          const labelData = labelResponse.data.labels[0];
          labelUrl = labelData.label_url || labelData.pdf_url || labelData.tracking_url || '';
          trackingNumber = trackingNumber || labelData.tracking_number || '';
          trackingCarrier = trackingCarrier || labelData.carrier || '';
        }

        if (!labelUrl) {
           console.warn('Starshipit returned success but no label URL was found in the response.');
        }

      } catch (labelError: any) {
        console.warn('Starshipit POST /orders/shipment Warning:', labelError.response?.data || labelError.message);
        const warning = parseStarshipitError(labelError.response?.data, labelError.message || 'Auto-label generation pending in Starshipit dashboard');
        return {
          orderId: starshipitOrder.order_id.toString(),
          trackingNumber,
          trackingCarrier,
          labelUrl,
          warning
        };
      }

      return {
        orderId: starshipitOrder.order_id.toString(),
        trackingNumber,
        trackingCarrier,
        labelUrl
      };
    } catch (error: any) {
      console.error('Starshipit API Error:', error.response?.data || error.message);
      const errMsg = parseStarshipitError(error.response?.data, error.message || 'Failed to create shipment with Starshipit');
      throw new Error(errMsg);
    }
  }

  public async getShipmentDetails(orderId: string): Promise<{
    trackingNumber?: string;
    trackingCarrier?: string;
    labelUrl?: string;
    shipmentStatus?: string;
    trackingUrl?: string;
  }> {
    try {
      const response = await axios.get(`${this.baseUrl}/orders?order_id=${orderId}`, { headers: this.headers });
      console.log('Starshipit GetShipmentDetails Response:', JSON.stringify(response.data, null, 2));
      const order = response.data?.order || (response.data?.orders && response.data.orders[0]);

      if (!order) {
        throw new Error('Order not found in Starshipit');
      }

      let trackingNumber = order.tracking_number || '';
      let trackingCarrier = order.carrier || '';
      let labelUrl = order.label_url || order.pdf_url || '';
      let trackingUrl = order.tracking_url || '';
      let shipmentStatus = order.status || '';

      if (order.packages && order.packages.length > 0) {
        const pkg = order.packages[0];
        trackingNumber = trackingNumber || pkg.tracking_number || '';
        trackingUrl = trackingUrl || pkg.tracking_url || '';

        if (pkg.labels && pkg.labels.length > 0) {
          labelUrl = labelUrl || pkg.labels[0].label_url || '';
        }
      }

      return {
        trackingNumber,
        trackingCarrier,
        labelUrl,
        trackingUrl,
        shipmentStatus
      };
    } catch (error: any) {
      console.error('Starshipit Get Shipment Details Error:', error.response?.data || error.message);
      throw new Error(error.response?.data?.message || 'Failed to fetch shipment details from Starshipit');
    }
  }
}

export const starshipitService = new StarshipitService();
