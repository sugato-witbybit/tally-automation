import express from "express";
import { utility } from "./utility.js";
import yaml from "yaml";
import fs from "fs";
import http from "http";

const app = express();
const port = 3000;

app.use(express.json());

async function generateXMLfromYAML(tblConfig, company, utility) {
  let retval = `<?xml version="1.0" encoding="utf-8"?><ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>MyReportLedgerTable</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>XML (Data Interchange)</SVEXPORTFORMAT><SVFROMDATE>{fromDate}</SVFROMDATE><SVTODATE>{toDate}</SVTODATE><SVCURRENTCOMPANY>{targetCompany}</SVCURRENTCOMPANY></STATICVARIABLES><TDL><TDLMESSAGE><REPORT NAME="MyReportLedgerTable"><FORMS>MyForm</FORMS></REPORT><FORM NAME="MyForm"><PARTS>MyPart01</PARTS></FORM>`;

  retval = retval.replace(
    "{targetCompany}",
    utility.String.escapeHTML(company)
  );

  let lstRoutes = tblConfig.collection.split(/\./g);
  let targetCollection = lstRoutes.splice(0, 1);
  lstRoutes.unshift("MyCollection");

  //loop through and append PART XML
  for (let i = 0; i < lstRoutes.length; i++) {
    let xmlPart = utility.Number.format(i + 1, "MyPart00");
    let xmlLine = utility.Number.format(i + 1, "MyLine00");
    retval += `<PART NAME="${xmlPart}"><LINES>${xmlLine}</LINES><REPEAT>${xmlLine} : ${lstRoutes[i]}</REPEAT><SCROLLED>Vertical</SCROLLED></PART>`;
  }
  //loop through and append LINE XML (except last line which contains field data)
  for (let i = 0; i < lstRoutes.length - 1; i++) {
    let xmlLine = utility.Number.format(i + 1, "MyLine00");
    let xmlPart = utility.Number.format(i + 2, "MyPart00");
    retval += `<LINE NAME="${xmlLine}"><FIELDS>FldBlank</FIELDS><EXPLODE>${xmlPart}</EXPLODE></LINE>`;
  }

  retval += `<LINE NAME="${utility.Number.format(
    lstRoutes.length,
    "MyLine00"
  )}">`;
  retval += `<FIELDS>`;
  retval = utility.String.strip(retval, 1);
  retval += `</FIELDS></LINE>`; //End of Field declaration

  for (let i = 0; i < tblConfig.fields.length; i++)
    retval +=
      utility.Number.format(i + 1, "Fld00") +
      (i < tblConfig.fields.length - 1 ? "," : "");

  for (let i = 0; i < tblConfig.fields.length; i++) {
    let fieldXML = `<FIELD NAME="${utility.Number.format(i + 1, "Fld00")}">`;
    let iField = tblConfig.fields[i];
    //set field TDL XML expression based on type of data
    if (/^(\.\.)?[a-zA-Z0-9_]+$/g.test(iField.field)) {
      if (iField.type == "text") fieldXML += `<SET>$${iField.field}</SET>`;
      else if (iField.type == "logical")
        fieldXML += `<SET>if $${iField.field} then 1 else 0</SET>`;
      else if (iField.type == "date")
        fieldXML += `<SET>if $$IsEmpty:$${iField.field} then $$StrByCharCode:241 else $$PyrlYYYYMMDDFormat:$${iField.field}:"-"</SET>`;
      else if (iField.type == "number")
        fieldXML += `<SET>if $$IsEmpty:$${iField.field} then "0" else $$String:$${iField.field}</SET>`;
      else if (iField.type == "amount")
        fieldXML += `<SET>$$StringFindAndReplace:(if $$IsDebit:$${iField.field} then -$$NumValue:$${iField.field} else $$NumValue:$${iField.field}):"(-)":"-"</SET>`;
      else if (iField.type == "quantity")
        fieldXML += `<SET>$$StringFindAndReplace:(if $$IsInwards:$${iField.field} then $$Number:$$String:$${iField.field}:"TailUnits" else -$$Number:$$String:$${iField.field}:"TailUnits"):"(-)":"-"</SET>`;
      else if (iField.type == "rate")
        fieldXML += `<SET>if $$IsEmpty:$${iField.field} then 0 else $$Number:$${iField.field}</SET>`;
      else fieldXML += `<SET>${iField.field}</SET>`;
    } else fieldXML += `<SET>${iField.field}</SET>`;
    fieldXML += `<XMLTAG>${utility.Number.format(i + 1, "F00")}</XMLTAG>`;
    fieldXML += `</FIELD>`;
    retval += fieldXML;
  }

  retval += `<FIELD NAME="FldBlank"><SET>""</SET></FIELD>`; //Blank Field specification
  //collection
  retval += `<COLLECTION NAME="MyCollection"><TYPE>${targetCollection}</TYPE>`;
  //fetch list
  if (tblConfig.fetch && tblConfig.fetch.length)
    retval += `<FETCH>${tblConfig.fetch.join(",")}</FETCH>`;
  //filter
  if (tblConfig.filters && tblConfig.filters.length) {
    retval += `<FILTER>`;
    for (let j = 0; j < tblConfig.filters.length; j++)
      retval += utility.Number.format(j + 1, "Fltr00") + ",";
    retval = utility.String.strip(retval); //remove last comma
    retval += `</FILTER>`;
  }
  retval += `</COLLECTION>`;
  //filter
  if (tblConfig.filters && tblConfig.filters.length)
    for (let j = 0; j < tblConfig.filters.length; j++)
      retval += `<SYSTEM TYPE="Formulae" NAME="${utility.Number.format(
        j + 1,
        "Fltr00"
      )}">${tblConfig.filters[j]}</SYSTEM>`;
  //XML footer
  retval += `</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  return retval;
}

function substituteTDLParameters(msg, substitutions, utility) {
  substitutions.forEach((value, key) => {
    let regExp = new RegExp(`\\{${key}\\}`, "g");
    msg = msg.replace(
      regExp,
      typeof value === "string"
        ? utility.String.escapeHTML(value)
        : value.toString()
    );
  });
  return msg;
}

function postTallyXML(msg, serverConfig) {
  return new Promise((resolve, reject) => {
    try {
      const req = http.request(
        {
          hostname: serverConfig.server,
          port: serverConfig.port,
          path: "", // Specify the path if needed
          method: "POST",
          headers: {
            "Content-Length": Buffer.byteLength(msg, "utf16le"),
            "Content-Type": "text/xml;charset=utf-16",
          },
        },
        (res) => {
          let data = "";
          res.setEncoding("utf16le");

          res.on("data", (chunk) => {
            let result = chunk.toString() || "";
            data += result;
          });

          res.on("end", () => {
            resolve(data);
          });

          // Add error handling for the response
          res.on("error", (httpErr) => {
            console.error("Response Error:", httpErr.message);
            reject(new Error(`Response error: ${httpErr.message}`));
          });
        }
      );

      req.on("error", (reqError) => {
        console.error("Request Error:", reqError.message);
        reject(new Error(`postTallyXML() error: ${reqError.message}`));
      });

      req.write(msg, "utf16le");
      req.end();
    } catch (err) {
      console.error("Post Tally XML Error:", err);
      reject(new Error(`postTallyXML() error: ${err.message}`));
    }
  });
}

function processTdlOutputManipulation(txt) {
  return txt
    .replace("<ENVELOPE>", "")
    .replace("</ENVELOPE>", "")
    .replace(/\<FLDBLANK\>\<\/FLDBLANK\>/g, "")
    .replace(/\s+\r\n/g, "")
    .replace(/\r\n/g, "")
    .replace(/\t/g, " ")
    .replace(/\s+\<F/g, "<F")
    .replace(/\<\/F\d+\>/g, "")
    .replace(/\<F01\>/g, "\r\n")
    .replace(/\<F\d+\>/g, "\t")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

async function processReport(targetTable, tableConfig, substitutions, config) {
  try {
    let company = substitutions.get("targetCompany");
    let fromDate = substitutions.get("fromDate"); // Ensure these values are set
    let toDate = substitutions.get("toDate");

    // Generate XML from the YAML table configuration
    let xml = await generateXMLfromYAML(
      tableConfig,
      company,
      utility,
      fromDate,
      toDate
    );

    // console.log(xml);
    // Substitute TDL parameters if needed
    if (substitutions && substitutions.size) {
      xml = await substituteTDLParameters(xml, substitutions, utility);
    }

    // Post XML to Tally and get the output
    console.log(xml)
    let output = await postTallyXML(xml, config);
    // console.log(xml)

    // Process the output from TDL manipulation
    output = await processTdlOutputManipulation(output);

    // Create the full output with column headers
    let columnHeaders = tableConfig.fields.map((p) => p.name).join("\t");
    const fullOutput = columnHeaders + output;
    let rows = fullOutput.split("\r\n");
    let headers = tableConfig.fields.map((field) => field.name);
    let jsonContent = rows.map((row) => {
      let values = row.split("\t");
      let rowObject = {};
      headers.forEach((header, idx) => (rowObject[header] = values[idx]));
      return rowObject;
    });

    return jsonContent;
  } catch (err) {
    throw new Error(`processReport(${targetTable}) error: ${err.message}`);
  }
}

app.post("/", async (req, res) => {
  try {
    let config = req.body.config;
    const importMaster = true;
    const importTransaction = true;

    let tallyPathExportDefinition = config.definition;
    if (fs.existsSync(`./${tallyPathExportDefinition}`)) {
      let objYAML = yaml.parse(
        fs.readFileSync(`./${tallyPathExportDefinition}`, "utf-8")
      );
      config.lstTableMaster = objYAML["master"];
      config.lstTableTransaction = objYAML["transaction"];
    } else {
      return res.status(400).send({
        status: "error",
        message: "Tally export definition file does not exist or is invalid.",
      });
    }

    let lstTables = [];
    if (importMaster) lstTables.push(...config.lstTableMaster);
    if (importTransaction) lstTables.push(...config.lstTableTransaction);

    let configTallyXML = new Map();
    configTallyXML.set(
      "fromDate",
      utility.Date.parse(config.fromDate, "yyyy-MM-dd")
    );
    configTallyXML.set(
      "toDate",
      utility.Date.parse(config.toDate, "yyyy-MM-dd")
    );
    configTallyXML.set(
      "targetCompany",
      config.company
        ? utility.String.escapeHTML(config.company)
        : "##SVCurrentCompany"
    );

    let jsonData = {};

    for (let i = 0; i < lstTables.length; i++) {
      let targetTable = lstTables[i].name;
      let tableConfig = lstTables[i];

      const substitutions = configTallyXML; // Map containing substitution values
      let jsonContent;

      try {
        jsonContent = await processReport(
          targetTable,
          tableConfig,
          substitutions,
          config
        );
      } catch (err) {
        console.error(
          `Error processing report for ${targetTable}:`,
          err.message
        );
        continue; // Skip to the next table on error
      }

      // Process the jsonContent and store it
      jsonData[targetTable] = jsonContent;
    }

    res.status(200).send({
      status: "success",
      message: "Data retrieved successfully",
      data: jsonData,
    });
  } catch (err) {
    console.log(err);
    res.status(500).send({
      status: "error",
      message: "An error occurred while processing the request.",
      error: err.message,
    });
  }
});

app.get("/", (req, res) => {
  res.status(200).send({
    status: "success",
    message: "Hello",
  });
});

app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});
