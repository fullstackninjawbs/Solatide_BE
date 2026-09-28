import axios from 'axios';
import { IOrder } from '../../models/order.model';
import ShippingPackage from '../../models/shippingPackage.model';
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

  if (rawMsg.includes('could not be created, but the import step did not return a specific validation error')) {
    return 'Shipping address is incomplete OR your Starshipit account is not configured with an International Courier capable of delivering to this country. Please verify the address, and ensure you have an international courier enabled in Starshipit.';
  }

  return rawMsg;
}

function getNormalizedShippingMethod(order: IOrder): string {
  const methodName = order.shippingMethodName;
  if (!methodName) {
    console.warn(`WARNING: Order ${order.orderNumber || order._id} is missing shippingMethodName. Returning empty string instead of blind fallback.`);
    return '';
  }

  const country = order.shippingAddressObj?.country?.toUpperCase() || 'AU';
  
  if (country !== 'AU') {
    if (methodName.startsWith('Standard - $')) {
      return 'Standard';
    }
    if (methodName.startsWith('Express - $')) {
      return 'Express';
    }
  }

  return methodName;
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
    
    const defaultPackage = await ShippingPackage.findOne({ isDefault: true, active: true });

    const street = order.shippingAddressObj?.street1 || (typeof order.shippingAddress === 'string' ? order.shippingAddress : undefined);
    const suburb = order.shippingAddressObj?.city || order.shippingAddressObj?.street2;
    const city = order.shippingAddressObj?.city;
    const state = order.shippingAddressObj?.state;
    const postCode = order.shippingAddressObj?.zip;
    const country = order.shippingAddressObj?.country || 'AU';

    const payload: any = {
      order_date: new Date().toISOString(),
      order_number: order.orderNumber || order._id?.toString(),
      reference: order.orderNumber || order._id?.toString(),
      shipping_method: getNormalizedShippingMethod(order),
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

    if (defaultPackage) {
      const pkgWeightKg = defaultPackage.weight?.unit === 'g' ? (defaultPackage.weight?.value || 500) / 1000 : (defaultPackage.weight?.value || weightKg || 0.5);
      payload.packages = [{
        weight: pkgWeightKg,
        length: defaultPackage.dimensions?.length ? defaultPackage.dimensions.length / 100 : 0.1,
        width: defaultPackage.dimensions?.width ? defaultPackage.dimensions.width / 100 : 0.1,
        height: defaultPackage.dimensions?.height ? defaultPackage.dimensions.height / 100 : 0.1
      }];
    }
    // If no default package, we completely omit 'packages' array to prevent "blank package" API errors
    // Starshipit will fallback to the default package set in their own dashboard or calculate from items.

    let starshipitOrderId = order.starshipitOrderId;
    let trackingNumber = '';
    let trackingCarrier = '';
    let labelUrl = '';

    try {
      if (!starshipitOrderId) {
        console.log('Sending payload to Starshipit /orders:', JSON.stringify(payload, null, 2));
        const response = await axios.post(`${this.baseUrl}/orders`, { order: payload }, { headers: this.headers });

        console.log('Starshipit POST /orders HTTP Status:', response.status);

        const starshipitOrder = response.data?.order;

        // Handle soft failures (HTTP 200 but success = false)
        // IMPORTANT: Even when success=false, Starshipit may have still CREATED the order and returned an order_id.
        // If we throw here without saving the order_id, the next retry will try to import again and fail.
        if (response.data && response.data.success === false) {
          const errMsg = parseStarshipitError(response.data, 'Starshipit API returned success=false');
          console.error('Starshipit returned soft failure. Detail:', errMsg);

          // If an order_id is present despite the failure, save it and treat as a warning
          if (starshipitOrder && starshipitOrder.order_id) {
            console.warn(`Starshipit created order ${starshipitOrder.order_id} but reported a soft failure. Saving order_id to prevent duplicate imports.`);
            starshipitOrderId = starshipitOrder.order_id.toString();
            trackingNumber = starshipitOrder.tracking_number || '';
            trackingCarrier = starshipitOrder.carrier || '';
            // Return early with orderId + warning so controller can save it
            return {
              orderId: starshipitOrderId,
              trackingNumber,
              trackingCarrier,
              labelUrl: '',
              warning: errMsg
            };
          }
          // No order_id in response — genuine failure, throw
          throw new Error(errMsg);
        }

        if (!starshipitOrder || !starshipitOrder.order_id) {
          throw new Error('Invalid response from Starshipit API: Missing order_id');
        }

        starshipitOrderId = starshipitOrder.order_id.toString();
        trackingNumber = starshipitOrder.tracking_number || '';
        trackingCarrier = starshipitOrder.carrier || '';
      } else {
        console.log(`Order ${order.orderNumber} already imported to Starshipit (ID: ${starshipitOrderId}). Skipping import step.`);
      }

      if (!starshipitOrderId) {
        throw new Error('Failed to obtain a valid Starshipit Order ID.');
      }

      try {
        console.log(`Calling POST /orders/shipment for order_id: ${starshipitOrderId}`);
        const labelResponse = await axios.post(`${this.baseUrl}/orders/shipment`, {
          order_id: parseInt(starshipitOrderId)
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
          orderId: starshipitOrderId,
          trackingNumber,
          trackingCarrier,
          labelUrl,
          warning
        };
      }

      return {
        orderId: starshipitOrderId,
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
