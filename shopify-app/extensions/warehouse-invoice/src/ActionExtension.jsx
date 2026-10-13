import '@shopify/ui-extensions/preact';
import {render} from 'preact';
import {useEffect, useState} from 'preact/hooks';
import {loadInvoice, NOT_READY} from './invoice.js';

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const [state, setState] = useState({loading: true});
  useEffect(() => {
    loadInvoice(shopify.data.selected?.[0]?.id)
      .then((inv) => setState({loading: false, ...inv}))
      .catch((e) => setState({loading: false, error: String(e?.message || e)}));
  }, []);

  return (
    <s-admin-action heading="Warehouse invoice" loading={state.loading}>
      {state.url ? (
        <s-stack gap="base">
          <s-paragraph>
            VAT invoice <s-text type="strong">{state.number || state.name}</s-text> for order {state.name}.
          </s-paragraph>
          <s-paragraph color="subdued">
            The same PDF the customer downloads from My account on the website.
          </s-paragraph>
        </s-stack>
      ) : (
        !state.loading && <s-paragraph>{state.error || NOT_READY}</s-paragraph>
      )}
      {state.url && (
        <s-button slot="primary-action" variant="primary" href={state.url} target="_blank">
          Download invoice
        </s-button>
      )}
      <s-button slot="secondary-actions" onClick={() => shopify.close()}>
        Close
      </s-button>
    </s-admin-action>
  );
}
