// Shared phone-number normalization for building WhatsApp JIDs.
//
// WhatsApp's own apps silently resolve a locally-typed number (e.g. an
// Indonesian "08xx...") to the full international form ("628xx...") based on
// the *device's own* SIM/registration country — that's why a connected
// device's own JID always comes back as 628xx even if it was registered by
// typing 08xx on the phone (see getConnectionInfo()). That auto-resolution
// is NOT something Baileys/WhatsApp do for the *recipient* number you pass
// in when sending — if you hand it "081234567890" verbatim, you get a JID
// for a literal (invalid) "081234567890" account, which will simply fail to
// resolve rather than being corrected for you.
//
// To avoid depending on that per-context guessing (and to support other
// countries later without silently mangling their numbers), we normalize
// explicitly and only for the one case we can be confident about: a
// nationally-formatted Indonesian number starting with a trunk "0".
export function normalizeMsisdn(input: string): string {
  let digits = input.replace(/\D/g, "");

  // Trunk-prefix "0" (Indonesian national format, e.g. 081234567890) ->
  // country code 62. Only applied when the number doesn't already carry a
  // country code (i.e. it still starts with the local trunk "0").
  if (digits.startsWith("0")) {
    digits = `62${digits.slice(1)}`;
  }

  return digits;
}

export function toJid(input: string): string {
  if (input.includes("@")) return input; // already a JID (group, or pre-built)
  return `${normalizeMsisdn(input)}@s.whatsapp.net`;
}
