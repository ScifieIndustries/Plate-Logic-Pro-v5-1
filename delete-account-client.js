// Plate Logic account deletion UI helper.
// Add this script after the Supabase client and wire the button to plOpenDeleteAccount().
window.plOpenDeleteAccount = function () {
  if (!window.currentUser) return;
  const ok = window.confirm(
    "Delete your Plate Logic account permanently? Your active subscription will be cancelled first."
  );
  if (!ok) return;
  window.plRunAccountDeletion();
};

window.plRunAccountDeletion = async function () {
  const button = document.getElementById("pl-delete-account-button");
  if (button) button.disabled = true;

  try {
    const { data, error } = await window.sb.functions.invoke("delete-account", { body: {} });
    if (error || !data?.success) {
      throw new Error(data?.error || "Could not delete the account.");
    }

    await window.sb.auth.signOut().catch(() => {});
    alert("Your Plate Logic account has been deleted.");
    window.location.reload();
  } catch (error) {
    console.error("Account deletion failed:", error);
    alert(error.message || "Could not delete the account. Please try again.");
    if (button) button.disabled = false;
  }
};
