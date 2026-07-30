import axios from 'axios';
import { IOrder } from '../../models/order.model';
import dotenv from 'dotenv';

dotenv.config();

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
  }> {
    const itemsCount = order.lineItems?.length || 1;
    const weightPerItem = weightKg / itemsCount;

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
        street: order.shippingAddressObj?.street1,
        suburb: order.shippingAddressObj?.city,
        city: order.shippingAddressObj?.city,
        state: order.shippingAddressObj?.state,
        post_code: order.shippingAddressObj?.zip,
        country: order.shippingAddressObj?.country || 'AU',
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
        console.error('Starshipit returned soft failure. Validation errors:', response.data.validation_errors);
        const errMsg = response.data.message || (response.data.validation_errors ? JSON.stringify(response.data.validation_errors) : 'Starshipit API returned success=false');
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
          throw new Error(labelResponse.data.message || 'Label generation failed in Starshipit');
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
        console.error('Starshipit POST /orders/shipment Error Details:', labelError.response?.data || labelError.message);
        throw new Error(labelError.response?.data?.message || labelError.message || 'Failed to dispatch shipment / generate label');
      }

      return {
        orderId: starshipitOrder.order_id.toString(),
        trackingNumber,
        trackingCarrier,
        labelUrl
      };
    } catch (error: any) {
      console.error('Starshipit API Error:', error.response?.data || error.message);
      throw new Error(error.response?.data?.message || error.message || 'Failed to create shipment with Starshipit');
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
