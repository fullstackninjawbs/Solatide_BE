import axios from 'axios';
import Order, { IOrder, IAddressObj } from '../models/order.model';
import config from '../config';

/**
 * Service to handle Google Address Validation.
 * API Docs: https://developers.google.com/maps/documentation/address-validation/
 */
export class AddressValidationService {
  /**
   * Validates the given order's shipping address using the Google Address Validation API.
   * If validation is successful, updates the order with the result and saves it.
   */
  public static async validateOrderAddress(orderId: string | any): Promise<void> {
    try {
      const apiKey = process.env.GOOGLE_ADDRESS_VALIDATION_API_KEY;
      if (!apiKey) {
        console.warn('[AddressValidationService] Missing GOOGLE_ADDRESS_VALIDATION_API_KEY in environment variables.');
        return;
      }

      const order = await Order.findById(orderId);
      if (!order) {
        console.warn(`[AddressValidationService] Order ${orderId} not found.`);
        return;
      }

      // Check if already validated
      if (order.addressValidation?.checkedAt) {
        return;
      }

      // Get address to validate
      const address = order.shippingAddressObj;
      if (!address || (!address.street1 && !address.city)) {
        console.warn(`[AddressValidationService] Order ${orderId} has no valid shippingAddressObj to validate.`);
        return;
      }

      // Prepare Google API request body
      const addressLines = [
        address.street1,
        address.street2
      ].filter(Boolean) as string[];

      const payload = {
        address: {
          regionCode: address.country || 'AU', // Default to Australia if missing
          locality: address.city,
          administrativeArea: address.state,
          postalCode: address.zip,
          addressLines: addressLines
        }
      };

      console.log(`[AddressValidationService] Validating address for Order ${orderId}...`);

      const response = await axios.post(
        `https://addressvalidation.googleapis.com/v1:validateAddress?key=${apiKey}`,
        payload
      );

      const result = response.data?.result;
      if (!result) {
        throw new Error('No result returned from Google Address Validation API.');
      }

      // Determine validation status based on verdict
      const verdict = result.verdict;
      
      let isValid = true;
      let needsReview = false;
      let validationMessage = '';

      // Typically, an address is good if it has good component precision and no unconfirmed components.
      if (
        verdict.hasUnconfirmedComponents ||
        verdict.validationGranularity === 'OTHER' || 
        verdict.geocodeGranularity === 'OTHER' ||
        verdict.hasReplacedComponents ||
        verdict.hasInferredComponents
      ) {
        isValid = false;
        needsReview = true;
        validationMessage = 'Address has unconfirmed or replaced/inferred components. Please review.';
      }

      // Format suggested address from google response
      let suggestedAddress: any = null;
      if (result.address && result.address.postalAddress) {
        const pa = result.address.postalAddress;
        suggestedAddress = {
          street1: pa.addressLines?.[0] || '',
          street2: pa.addressLines?.[1] || '',
          city: pa.locality || '',
          state: pa.administrativeArea || '',
          zip: pa.postalCode || '',
          country: pa.regionCode || ''
        };
      }

      // Update order
      order.addressValidation = {
        isValid,
        needsReview,
        validationMessage,
        suggestedAddress: needsReview ? suggestedAddress : null,
        googleResponse: result,
        checkedAt: new Date()
      };

      await order.save({ validateBeforeSave: false });
      
      console.log(`[AddressValidationService] Validation complete for Order ${orderId}. Needs Review: ${needsReview}`);

    } catch (error: any) {
      console.error(`[AddressValidationService] Error validating address for Order ${orderId}:`, error?.response?.data || error.message);
      
      // Update order to indicate validation failed (so we don't try again repeatedly)
      try {
        const order = await Order.findById(orderId);
        if (order) {
          order.addressValidation = {
            isValid: false,
            needsReview: false, // We don't necessarily want to block the order if API goes down, but we log it
            validationMessage: 'Validation API failed or was unreachable',
            checkedAt: new Date()
          };
          await order.save({ validateBeforeSave: false });
        }
      } catch (innerError) {
        console.error(`[AddressValidationService] Failed to mark order ${orderId} as failed validation.`, innerError);
      }
    }
  }
}

export default AddressValidationService;
