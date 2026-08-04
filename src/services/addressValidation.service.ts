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


      console.log(payload)

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

      // 1. (Removed: Unconfirmed components check)
      // 2. (Removed: Granularity / Not fully confirmed check)

      // 3. Inspect individual components for serious replacements/inferences (ignore benign formatting)
      const unexpectedComponents: string[] = [];
      const suspiciousComponents: string[] = [];
      let postcodeReplaced = false;

      if (result.address && result.address.addressComponents) {
        for (const comp of result.address.addressComponents) {
          const type = comp.componentType;
          const text = comp.componentName?.text;
          if (!text || text.toLowerCase() === 'undefined') continue;

          if (comp.unexpected) {
            needsReview = true;
            isValid = false;
            unexpectedComponents.push(text);
          }

          if (comp.confirmationLevel === 'UNCONFIRMED_AND_SUSPICIOUS') {
            needsReview = true;
            isValid = false;
            suspiciousComponents.push(text);
          }

          // Flag if postcode was replaced by a completely different one (ignore inferred as it's a helpful correction)
          if (type === 'postal_code' && comp.replaced) {
            needsReview = true;
            isValid = false;
            postcodeReplaced = true;
          }
        }
      }

      // 4. Missing required components
      const missingComponents: string[] = [];
      const missingComponentsMap: Record<string, string> = {
        street_number: 'house/street number',
        route: 'street name',
        locality: 'city/suburb',
        administrative_area_level_1: 'state/province',
        postal_code: 'ZIP/postal code',
        country: 'country'
      };

      if (result.address && result.address.missingComponentTypes && result.address.missingComponentTypes.length > 0) {
        needsReview = true;
        isValid = false;
        for (const t of result.address.missingComponentTypes) {
          const mapped = missingComponentsMap[t];
          if (mapped) missingComponents.push(mapped);
        }
      }

      // Build clean user-centric validation message
      const messages: string[] = [];
      if (unexpectedComponents.length > 0) {
        const uniqueUnexpected = Array.from(new Set(unexpectedComponents));
        messages.push(`The following details seem incorrect or out of place: "${uniqueUnexpected.join(', ')}".`);
      }
      if (suspiciousComponents.length > 0) {
        const uniqueSuspicious = Array.from(new Set(suspiciousComponents));
        messages.push(`Could not verify: "${uniqueSuspicious.join(', ')}".`);
      }
      if (postcodeReplaced) {
        messages.push('The postal code was incorrect and has been updated.');
      }
      if (missingComponents.length > 0) {
        messages.push(`Please add the missing ${missingComponents.join(', ')}.`);
      }

      const validationMessage = messages.join(' ') || 'Address is valid';

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
      console.log(`- needsReview evaluated to: ${needsReview}. Reasons: ${validationMessage}\n`);

      // Update order
      order.addressValidation = {
        isValid,
        needsReview,
        validationMessage,
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
