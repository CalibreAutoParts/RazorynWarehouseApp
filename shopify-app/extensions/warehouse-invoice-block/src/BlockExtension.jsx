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
    <s-admin-block heading="Warehouse invoice">
      {state.loading ? (
        <s-text color="subdued">Loading…</s-text>
      ) : state.url ? (
        <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
          <s-text type="strong">{state.number || state.name}</s-text>
          <s-button href={state.url} target="_blank" icon="download">
            Download invoice
          </s-button>
        </s-stack>
      ) : (
        <s-text color="subdued">{state.error || NOT_READY}</s-text>
      )}
    </s-admin-block>
  );
}
