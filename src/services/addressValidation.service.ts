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
      let reasons: string[] = [];

      // 1. Unconfirmed components
      if (verdict.hasUnconfirmedComponents) {
        needsReview = true;
        isValid = false;
        reasons.push('Unconfirmed address components found');
      }

      // 2. Granularity / Not fully confirmed
      if (verdict.validationGranularity === 'OTHER' || verdict.geocodeGranularity === 'OTHER') {
        needsReview = true;
        isValid = false;
        reasons.push('Address granularity is poor (not fully confirmed)');
      }

      // 3. Inspect individual components for serious replacements/inferences (ignore benign formatting)
      if (result.address && result.address.addressComponents) {
        for (const comp of result.address.addressComponents) {
          const type = comp.componentType;
          
          if (comp.unexpected) {
             needsReview = true;
             isValid = false;
             reasons.push(`Unexpected component found: ${comp.componentName?.text}`);
          }
          
          if (comp.confirmationLevel === 'UNCONFIRMED_BUT_PLAUSIBLE' || comp.confirmationLevel === 'UNCONFIRMED_AND_SUSPICIOUS') {
             needsReview = true;
             isValid = false;
             reasons.push(`Component '${comp.componentName?.text}' could not be confirmed`);
          }

          // Flag if postcode was inferred or replaced (City/State/Postcode mismatch)
          if (type === 'postal_code' && (comp.replaced || comp.inferred)) {
             needsReview = true;
             isValid = false;
             reasons.push(`Postcode was ${comp.replaced ? 'replaced' : 'inferred'}: ${comp.componentName?.text}`);
          }
        }
      }

      // 4. Missing required components
      if (result.address && result.address.missingComponentTypes && result.address.missingComponentTypes.length > 0) {
        needsReview = true;
        isValid = false;
        reasons.push(`Missing required components: ${result.address.missingComponentTypes.join(', ')}`);
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

      // Add detailed debug logs
      console.log(`\n[AddressValidationService] DEBUG for Order ${orderId}:`);
      console.log(`- Original Address: ${JSON.stringify(address)}`);
      console.log(`- Google Formatted Address: ${result.address?.postalAddress?.addressLines?.join(', ') || 'N/A'}`);
      console.log(`- Google Verdict: ${JSON.stringify(verdict)}`);
      console.log(`- needsReview evaluated to: ${needsReview}. Reasons: ${reasons.length > 0 ? reasons.join('; ') : 'None'}\n`);

      // Update order
      order.addressValidation = {
        isValid,
        needsReview,
        validationMessage: reasons.join('; ') || 'Address is valid',
        suggestedAddress, // Always save for reference
        googleResponse: result,
        checkedAt: new Date()
      };

      await order.save({ validateBeforeSave: false });
      
      console.log(`[AddressValidationService] Validation complete for Order ${orderId}. Needs Review: ${needsReview}`);

    } catch (error: any) {
      console.error(`[AddressValidationService] Error validating address for Order ${orderId}:`, error?.response?.data || error.message);
      
      const isBadRequest = error?.response?.status === 400;
      const errorMessage = error?.response?.data?.error?.message || 'Validation API failed or was unreachable';

      // Update order to indicate validation failed (so we don't try again repeatedly)
      try {
        const order = await Order.findById(orderId);
        if (order) {
          order.addressValidation = {
            isValid: false,
            needsReview: isBadRequest, // If it's a 400 bad request, it's an invalid address so it needs review
            validationMessage: isBadRequest ? `Invalid Address: ${errorMessage}` : 'Validation API failed or was unreachable',
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
