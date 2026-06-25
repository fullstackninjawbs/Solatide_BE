import Tagada from '@tagadapay/node-sdk';

const tagada = new Tagada('sk_crm_807db62276def2889216044bd06fd7439f81b76941949bff');

async function test() {
  try {
    const products = await tagada.products.list({ storeId: 'store_6b8fa1a123cf' });
    console.log("Products:", JSON.stringify(products, null, 2));
    
    if (products.data && products.data.length > 0) {
      const variantId = products.data[0].variants[0].id;
      console.log("Using variant:", variantId);
      
      const session = await tagada.checkout.createSession({
        storeId: 'store_6b8fa1a123cf',
        items: [{ variantId, quantity: 1 }],
        currency: 'AUD',
        checkoutUrl: 'https://simple-checkout--store_6b8fa1a123cf.cdn.tagada.io/checkout'
      });
      console.log("Success Session:", session);
    }
  } catch (err) {
    console.error("Error from Tagada:", err.message);
    if (err.raw) {
      console.error("Response data:", err.raw);
    }
  }
}
test();
