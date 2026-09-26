    function apply(ctx) {
      ctx.effect(() => injectStyles());
      // 详情页追加区：宿主按主题分发，本块对非本插件主题返回 null。
      // plugins.detail.section 由 client-ui-plugin-manager 的 main 入口声明，
      // slots.inject 会等待该座位出现，故无需在 inject 里声明硬依赖。
      ctx.slots.inject("plugins.detail.section", () => ctx.slots.register({
        name: "plugins.detail.section",
        id: "workspace-acl-allow",
        order: 100,
      }, WhitelistSection));
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  }
});
