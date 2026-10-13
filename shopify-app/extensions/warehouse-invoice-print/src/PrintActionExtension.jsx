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
    <s-admin-print-action src={state.url || undefined}>
      {!state.loading && !state.url && <s-text>{state.error || NOT_READY}</s-text>}
    </s-admin-print-action>
  );
}
