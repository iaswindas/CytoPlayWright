describe("Wrapped primitive values", () => {
  it("passes wrapped primitives straight through then callbacks", () => {
    cy.wrap("manager").then((role) => {
      cy.contains(role).should("be.visible");
    });
  });
});
