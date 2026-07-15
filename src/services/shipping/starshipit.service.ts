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
    // 1. Construct Starshipit order payload
    // Note: Starshipit expects individual item weights, so we distribute the total weight evenly 
    // across items as a fallback since the current logic calculates total weight only.
    const itemsCount = order.lineItems?.length || 1;
    const weightPerItem = weightKg / itemsCount;

    const payload = {
      order_date: new Date().toISOString(),
      order_number: order.orderNumber || order._id?.toString(),
      reference: order.orderNumber || order._id?.toString(),
      destination: {
        name: order.shippingAddressObj?.name || (order.customer?.firstName ? `${order.customer.firstName} ${order.customer.lastName || ''}`.trim() : 'Customer'),
        company: order.shippingAddressObj?.company,
        street: order.shippingAddressObj?.street1,
        suburb: order.shippingAddressObj?.city, // Mapping city to suburb if needed
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

    // 2. Call Starshipit API
    try {
      const response = await axios.post(`${this.baseUrl}/orders`, { order: payload }, { headers: this.headers });
      console.log('Starshipit Orders Response:', JSON.stringify(response.data, null, 2));
      
      const starshipitOrder = response.data?.order;
      if (!starshipitOrder || !starshipitOrder.order_id) {
        console.error('Starshipit Failed Response:', JSON.stringify(response.data, null, 2));
        if (response.data && response.data.success === false) {
           throw new Error(response.data.message || 'Starshipit API returned failure');
        }
        throw new Error('Invalid response from Starshipit API');
      }

      let trackingNumber = starshipitOrder.tracking_number || '';
      let trackingCarrier = starshipitOrder.carrier || '';
      let labelUrl = '';

      // 3. Generate Label & Get Tracking
      // In Starshipit, you typically call /orders/shipment to assign a courier and generate the label
      try {
        const labelResponse = await axios.post(`${this.baseUrl}/orders/shipment`, { 
          order_id: starshipitOrder.order_id 
        }, { headers: this.headers });
        console.log('Starshipit Label Response:', JSON.stringify(labelResponse.data, null, 2));
        
        // The response structure varies, but usually contains order details with tracking
        const shippedOrder = labelResponse.data?.order || labelResponse.data?.orders?.[0];
        if (shippedOrder) {
          trackingNumber = trackingNumber || shippedOrder.tracking_number || '';
          trackingCarrier = trackingCarrier || shippedOrder.carrier || '';
          // Some configurations return labels directly or via tracking url
          labelUrl = shippedOrder.label_url || shippedOrder.pdf_url || shippedOrder.tracking_url || labelUrl;
        } else if (labelResponse.data && labelResponse.data.labels && labelResponse.data.labels.length > 0) {
          const labelData = labelResponse.data.labels[0];
          labelUrl = labelData.label_url || labelData.pdf_url || labelData.tracking_url || '';
          trackingNumber = trackingNumber || labelData.tracking_number || '';
          trackingCarrier = trackingCarrier || labelData.carrier || '';
        }
      } catch (labelError: any) {
        console.warn('Could not automatically dispatch/generate label. Order created but requires manual dispatch:', labelError.response?.data || labelError.message);
      }

      return {
        orderId: starshipitOrder.order_id.toString(),
        trackingNumber,
        trackingCarrier,
        labelUrl 
      };
    } catch (error: any) {
      console.error('Starshipit API Error:', error.response?.data || error.message);
      throw new Error(error.response?.data?.message || 'Failed to create shipment with Starshipit');
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
