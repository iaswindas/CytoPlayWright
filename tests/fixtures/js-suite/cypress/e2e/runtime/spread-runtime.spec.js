describe("Spread runtime", function () {
  it("reads grid values from the browser runtime", function () {
    cy.window().then((appWindow) => {
      let spreadHostElement = appWindow.document.querySelector('[gcuielement="gcSpread"]');
      let spread = appWindow.GC.Spread.Sheets.findControl(spreadHostElement);
      let activeSheet = spread.getActiveSheet();
      let value = activeSheet.getValue(116, 5);
      expect(value).to.eq("Total Revenue");
    });
  });
});
