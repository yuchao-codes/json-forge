export default defineBackground(() => {
  browser.action.onClicked.addListener(() => {
    void browser.tabs.create({ url: browser.runtime.getURL('/workbench.html') })
      .catch((error: unknown) => console.error('Unable to open JSON Forge', error));
  });
});
