/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is the GuidedBugEntry Bugzilla Extension.
 *
 * The Initial Developer of the Original Code is
 * the Mozilla Foundation.
 * Portions created by the Initial Developer are Copyright (C) 2011
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   Byron Jones <glob@mozilla.com>
 *
 * ***** END LICENSE BLOCK ***** */

// global

var Dom = YAHOO.util.Dom;
var Event = YAHOO.util.Event;
var History = YAHOO.util.History;

var guided = {
  _currentStep: '',

  setStep: function(newStep) {
    // initialise new step
    eval(newStep + '.onShow()');

    // change visibility of _step div
    if (this._currentStep)
      Dom.addClass(this._currentStep + '_step', 'hidden');
    this._currentStep = newStep;
    Dom.removeClass(this._currentStep + '_step', 'hidden');

    // scroll to top of page to mimic real navigation
    scroll(0,0);

    // update history
    History && History.navigate('h', newStep + "|" + product.getName());
  },

  init: function() {
    // init history manager
    try {
      History.register('h', History.getBookmarkedState('h') || 'product', this._onStateChange);
      History.initialize("yui-history-field", "yui-history-iframe");
      History.onReady(function () {
        guided._onStateChange(History.getCurrentState('h'));
      });
    } catch(err) {
      History = false;
    }

    // init steps
    product.onInit();
    dupes.onInit();
    bugForm.onInit();
  },

  _onStateChange: function(state) {
    state = state.split("|");
    product.setName(state[1] || '');
    guided.setStep(state[0]);
  },

  onAdvancedClick: function() {
    document.location.href = 'enter_bug.cgi?format=__default__&product=' + escape(product.getName());
    return false;
  }
};

// product step

var product = {
  details: false,
  _post_counter: 0,

  onInit: function() { },
  onShow: function() { },

  select: function(productName) {
    // called when a product is selected
    this.setName(productName);
    dupes.reset();
    guided.setStep('dupes');
  },

  getName: function() {
    return Dom.get('product').value;
  },

  _getNameAndRelated: function() {
    var result = [];

    var name = this.getName();
    result.push(name);

    if (products[name] && products[name].related) {
      for (var i = 0, n = products[name].related.length; i < n; i++) {
        result.push(products[name].related[i]);
      }
    }

    return result;
  },

  setName: function(productName) {
    if (productName == this.getName() && this.details)
      return;

    Dom.get('product').value = productName;
    Dom.get('product_label').innerHTML = productName;

    if (productName == '') {
      Dom.addClass("product_support", "hidden");
      return;
    }

    // show support message
    if (products[productName] && products[productName].support) {
      Dom.get("product_support_message").innerHTML = products[productName].support;
      Dom.removeClass("product_support", "hidden");
    } else {
      Dom.addClass("product_support", "hidden");
    }

    // grab the product information
    this.details = false;
    YAHOO.util.Connect.setDefaultPostHeader('text/plain; charset=UTF-8');
    YAHOO.util.Connect.asyncRequest(
      'POST',
      'jsonrpc.cgi',
      {
        success: function(res) {
          try {
            data = YAHOO.lang.JSON.parse(res.responseText);
            if (data.error)
              throw(data.error.message);
            product.details = data.result.products[0];
            bugForm.onProductUpdated();
          } catch (err) {
            product.details = false;
            bugForm.onProductUpdated();
            if (err) {
              alert('Failed to retreive components for product "' + productName + '":' + "\n\n" + err);
              if (console)
                console.error(err);
            }
          }
        },
        failure: function(res) {
          product.details = false;
          bugForm.onProductUpdated();
          if (res.responseText) {
            alert('Failed to retreive components for product "' + productName + '":' + "\n\n" + res.responseText);
            if (console)
              console.error(res);
          }
        }
      },
      YAHOO.lang.JSON.stringify({
        version: "1.1",
        method: "Product.get",
        id: ++this._post_counter,
        params: {
            names: [productName],
            exclude_fields: ['internals', 'milestones']
        }
      }
      )
    );
  }
};

// other products step

var otherProducts = {
  onInit: function() { },
  onShow: function() { }
};

// duplicates step

var dupes = {
  _counter: 0,
  _dataTable: null,
  _dataTableColumns: null,
  _formatCcLabel: "",
  _elSummary: null,
  _elSearch: null,
  _elList: null,

  onInit: function() {
    this._elSummary = Dom.get('dupes_summary');
    this._elSearch = Dom.get('dupes_search');
    this._elList = Dom.get('dupes_list');

    Event.onBlur(this._elSummary, this._onSummaryBlur);
    Event.addListener(this._elSummary, 'keydown', this._onSummaryKeyDown);
    Event.addListener(this._elSummary, 'keyup', this._onSummaryKeyUp);
    Event.addListener(this._elSearch, 'click', this._doSearch);
  },

  setLabels: function(labels) {
    this._dataTableColumns = [
      { key: "id", label: labels.id, formatter: this._formatId },
      { key: "summary", label: labels.summary, formatter: "text" },
      { key: "status", label: labels.status, formatter: this._formatStatus },
      { key: "update_token", label: '', formatter: this._formatCc }
    ];
    this._formatCcLabel = labels.cc;
  },

  _initDataTable: function() {
    var dataSource = new YAHOO.util.XHRDataSource("jsonrpc.cgi");
    dataSource.connTimeout = 30000;
    dataSource.connMethodPost = true;
    dataSource.connXhrMode = "cancelStaleRequests";
    dataSource.maxCacheEntries = 3;
    dataSource.responseSchema = {
      resultsList : "result.bugs",
      metaFields : { error: "error", jsonRpcId: "id" }
    };
    // DataSource can't understand a JSON-RPC error response, so
    // we have to modify the result data if we get one.
    dataSource.doBeforeParseData = 
      function(oRequest, oFullResponse, oCallback) {
        if (oFullResponse.error) {
          oFullResponse.result = {};
          oFullResponse.result.bugs = [];
          if (console)
            console.log("JSON-RPC error:", oFullResponse.error);
        }
        return oFullResponse;
      };

    this._dataTable = new YAHOO.widget.DataTable(
      'dupes_list', 
      this._dataTableColumns, 
      dataSource, 
      { 
        initialLoad: false,
        MSG_EMPTY: 'No similar issues found.',
        MSG_ERROR: 'An error occurred while searching for similar issues, please try again.'
      }
    );
  },

  _formatId: function(el, oRecord, oColumn, oData) {
    el.innerHTML = '<a href="show_bug.cgi?id=' + oData + '" target="_blank">' + oData + '</a>';
  },

  _formatStatus: function(el, oRecord, oColumn, oData) {
    var resolution = oRecord.getData('resolution');
    var bug_status = display_value('bug_status', oData);
    if (resolution) {
      el.innerHTML = bug_status + ' ' + display_value('resolution', resolution);
    } else {
      el.innerHTML = bug_status;
    }
  },

  _formatCc: function(el, oRecord, oColumn, oData) {
    var url = 'process_bug.cgi?id=' + oRecord.getData('id') + '&addselfcc=1&token=' + escape(oData);
    var button = document.createElement('button');
    button.setAttribute('type', 'button');
    button.innerHTML = dupes._formatCcLabel;
    button.onclick = function() { window.location = url; return false; };
    el.appendChild(button);
  },

  reset: function() {
    this._elSummary.value = '';
    Dom.addClass(this._elList, 'hidden');
    Dom.addClass('dupes_continue', 'hidden');
    this._elList.innerHTML = '';
    this._showProductSupport();
  },

  _showProductSupport: function() {
    var elSupport = Dom.get('product_support_' + product.getName().replace(' ', '_').toLowerCase());
    var supportElements = Dom.getElementsByClassName('product_support');
    for (var i = 0, n = supportElements.length; i < n; i++) {
      if (supportElements[i] == elSupport) {
        Dom.removeClass(elSupport, 'hidden');
      } else {
        Dom.addClass(supportElements[i], 'hidden');
      }
    }
  },

  onShow: function() {
    this._showProductSupport();
    this._onSummaryBlur();

    // hide the advanced form entry until a search has happened
    Dom.addClass('advanced', 'hidden');

    if (!this._elSearch.disabled && this.getSummary().length >= 4) {
      // do an immediate search after a page refresh if there's a query
      this._doSearch();

    } else {
      // prepare for a search
      this.reset();
    }
  },

  _onSummaryBlur: function() {
    dupes._elSearch.disabled = dupes._elSummary.value == '';
  },

  _onSummaryKeyDown: function(e) {
    // map <enter> to doSearch()
    if (e && (e.keyCode == 13)) {
      dupes._doSearch();
      Event.stopPropagation(e);
    }
  },

  _onSummaryKeyUp: function(e) {
    // disable search button until there's a query
    dupes._elSearch.disabled = YAHOO.lang.trim(dupes._elSummary.value) == '';
  },

  _doSearch: function() {
    if (dupes.getSummary().length < 4) {
      alert('The summary must be at least 4 characters long.');
      return;
    }
    dupes._elSummary.blur();

    // initialise the datatable as late as possible
    dupes._initDataTable();

    try {
      // run the search
      Dom.removeClass(dupes._elList, 'hidden');

	    dupes._dataTable.showTableMessage(
        'Searching for similar issues...&nbsp;&nbsp;&nbsp;' +
        '<img src="extensions/GuidedBugEntry/web/images/throbber.gif" width="16" height="11">',
        YAHOO.widget.DataTable.CLASS_LOADING
      );
      var json_object = {
          version: "1.1",
          method: "Bug.possible_duplicates",
          id: ++dupes._counter,
          params: {
              product: product._getNameAndRelated(),
              summary: dupes.getSummary(),
              limit: 12,
              include_fields: [ "id", "summary", "status", "resolution", "update_token" ]
          }
      };

      dupes._dataTable.getDataSource().sendRequest(
        YAHOO.lang.JSON.stringify(json_object), 
        {
          success: dupes._onDupeResults,
          failure: dupes._onDupeResults,
          scope: dupes._dataTable,
          argument: dupes._dataTable.getState() 
        }
      );

      Dom.get('dupes_continue_button').disabled = true;
      Dom.removeClass('dupes_continue', 'hidden');
    } catch(err) {
      if (console)
        console.error(err.message);
    }
  },

  _onDupeResults: function(sRequest, oResponse, oPayload) {
    Dom.removeClass('advanced', 'hidden');
    Dom.get('dupes_continue_button').disabled = false;
    dupes._dataTable.onDataReturnInitializeTable(sRequest, oResponse, oPayload);
  },

  getSummary: function() {
    var summary = YAHOO.lang.trim(this._elSummary.value);
    // work around chrome bug
    if (summary == dupes._elSummary.getAttribute('placeholder')) {
      return '';
    } else {
      return summary;
    }
  }
};

// bug form step

var bugForm = {
  _visibleHelpPanel: null,
  _mandatoryFields: [ 'short_desc', 'version_select' ],

  onInit: function() {
    Dom.get('user_agent').value = navigator.userAgent;
    Dom.get('build_id').value = navigator.buildID ? navigator.buildID : '';
  },

  onShow: function() {
    // default the summary to the dupes query
    Dom.get('short_desc').value = dupes.getSummary();
    Dom.get('submit').disabled = false;
    Dom.get('submit').value = 'Submit Bug';
    if (Dom.get('component_select').length == 0)
      this.onProductUpdated();
    this.onFileChange();
    for (var i = 0, n = this._mandatoryFields.length; i < n; i++) {
      Dom.removeClass(this._mandatoryFields[i], 'missing');
    }
  },

  onProductUpdated: function() {
    var productName = product.getName();

    // init
    var elComponents = Dom.get('component_select');
    Dom.addClass('component_description', 'hidden');
    elComponents.options.length = 0;

    var elVersions = Dom.get('version_select');
    elVersions.length = 0;

    // product not loaded yet, bail out
    if (!product.details) {
      Dom.addClass('versionTH', 'hidden');
      Dom.addClass('versionTD', 'hidden');
      Dom.get('productTD').colSpan = 2;
      Dom.get('submit').disabled = true;
      return;
    }
    Dom.get('submit').disabled = false;

    // build components
    // if there's a general component in it, make it selected by default
    var defaultComponent = false;
    for (var i = 0, n = product.details.components.length; i < n; i++) {
      var component = product.details.components[i];
      if (component.is_active == '1') {
        elComponents.options[elComponents.options.length] = new Option(component.name, component.name);
        if (!defaultComponent && component.name.match(/general/i)) {
          defaultComponent = component.name;
        }
      }
    }

    var elComponent = Dom.get('component');
    if (elComponent.value == '' && defaultComponent)
      elComponent.value = defaultComponent;
    if (elComponent.value != '') {
      elComponents.value = elComponent.value;
      this.onComponentChange(elComponent.value);
    }
    Dom.get('component_help_describe').href = 'describecomponents.cgi?product=' + escape(productName);

    // build versions
    var defaultVersion = '';
    var currentVersion = Dom.get('version').value;
    for (var i = 0, n = product.details.versions.length; i < n; i++) {
      var version = product.details.versions[i];
      if (version.is_active == '1') {
        elVersions.options[elVersions.options.length] = new Option(version.name, version.name);
        if (currentVersion == version.name)
          defaultVersion = version.name;
      }
    }

    if (!defaultVersion) {
      // try to detect version on a per-product basis
      if (products[productName] && products[productName].version) {
        var detectedVersion = products[productName].version();
        var options = elVersions.options;
        for (var i = 0, n = options.length; i < n; i++) {
          if (options[i].value == detectedVersion) {
            defaultVersion = detectedVersion;
            break;
          }
        }
      }
    }
    if (!defaultVersion) {
      // load last selected version
      defaultVersion = YAHOO.util.Cookie.get('VERSION-' + productName);
    }

    if (elVersions.length > 1) {
      // more than one version, show select
      Dom.get('productTD').colSpan = 1;
      Dom.removeClass('versionTH', 'hidden');
      Dom.removeClass('versionTD', 'hidden');

    } else {
      // if there's only one version, we don't need to ask the user
      Dom.addClass('versionTH', 'hidden');
      Dom.addClass('versionTD', 'hidden');
      Dom.get('productTD').colSpan = 2;
      defaultVersion = elVersions.options[0].value;
    }

    if (defaultVersion) {
      elVersions.value = defaultVersion;

    } else {
      // no default version, select an empty value to force a decision
      var opt = new Option('', '');
      try {
        // standards
        elVersions.add(opt, elVersions.options[0]);
      } catch(ex) {
        // ie only
        elVersions.add(opt, 0);
      }
      elVersions.value = '';
    }
    bugForm.onVersionChange(elVersions.value);
  },

  onComponentChange: function(componentName) {
    // show the component description
    Dom.get('component').value = componentName;
    var elComponentDesc = Dom.get('component_description');
    elComponentDesc.innerHTML = '';
    for (var i = 0, n = product.details.components.length; i < n; i++) {
      var component = product.details.components[i];
      if (component.name == componentName) {
        elComponentDesc.innerHTML = component.description;
        break;
      }
    }
    Dom.removeClass(elComponentDesc, 'hidden');
  },

  onVersionChange: function(version) {
    Dom.get('version').value = version;
  },

  onFileChange: function() {
    // toggle ui enabled when a file is uploaded or cleared
    var elFile = Dom.get('data');
    var elReset = Dom.get('reset_data');
    var elDescription = Dom.get('data_description');
    var filename = elFile.value;
    if (filename) {
      elReset.disabled = false;
      elDescription.value = filename;
      elDescription.disabled = false;
      Dom.get('data_description').value = filename;
    } else {
      elReset.disabled = true;
      elDescription.value = '';
      elDescription.disabled = true;
    }
  },

  onFileClear: function() {
    Dom.get('data').value = '';
    this.onFileChange();
    return false;
  },

  _mandatoryCheck: function() {
    result = true;
    for (var i = 0, n = this._mandatoryFields.length; i < n; i++ ) {
      id = this._mandatoryFields[i];
      el = Dom.get(id);

      if (el.type.toString() == "checkbox") {
        value = el.checked;
      } else {
        value = el.value.replace(/^\s\s*/, '').replace(/\s\s*$/, '');
        el.value = value;
      }

      if (value == '') {
        Dom.addClass(id, 'missing');
        result = false;
      } else {
        Dom.removeClass(id, 'missing');
      }
    }
    return result;
  },

  validate: function() {
    
    // check mandatory fields

    if (!bugForm._mandatoryCheck()) {
      if (Dom.hasClass('short_desc', 'missing') && Dom.hasClass('version_select', 'missing')) {
        alert('Please enter the summary, and select the relevant version.');
      } else if (Dom.hasClass('short_desc', 'missing')) {
        alert('Please enter the summary.');
      } else {
        alert('Please select the relevant version.\n\nIf you are unsure select "unspecified".');
      }

      return false;
    }

    if (Dom.get('data').value && !Dom.get('data_description').value)
      Dom.get('data_description').value = Dom.get('data').value;

    Dom.get('submit').disabled = true;
    Dom.get('submit').value = 'Submitting Bug...';

    return true;
  },

  toggleHelp: function(el) {
    var help_id = el.getAttribute('helpid');
    if (!el.panel) {
      if (!el.id)
        el.id = help_id + '_parent';
      el.panel = new YAHOO.widget.Panel(
        help_id, 
        { 
          width: "320px", 
          visible: false,
          close: false,
          context: [el.id, 'tl', 'tr', null, [5, 0]]
        }
      );
      el.panel.render();
      Dom.removeClass(help_id, 'hidden');
    }
    if (Dom.getStyle(Dom.get(help_id).parentNode, 'visibility') == 'visible') {
      if (this._visibleHelpPanel)
        this._visibleHelpPanel.hide();
      el.panel.hide();
      this._visibleHelpPanel = null;
    } else {
      if (this._visibleHelpPanel)
        this._visibleHelpPanel.hide();
      el.panel.show();
      this._visibleHelpPanel = el.panel;
    }
  }
}

